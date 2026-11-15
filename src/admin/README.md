# Admin shell: how to build a screen

Everything the admin screens share lives in `src/admin/`: the page frame, the components, the words, the form helpers
and one small browser script. A screen is one Astro page under `src/pages/admin/` that uses them. Open
**`/admin/styleguide/`** in `npm run dev` to see every component in every state; its source,
`src/pages/admin/styleguide.astro`, is the copy-paste reference for this file.

Design: `admin-portal-design.md` §5, with `admin-portal-amendments.md` taking priority. Both sit outside the repo.

## Contents

1. [Files](#files)
2. [A screen in 30 lines](#a-screen-in-30-lines)
3. [AdminLayout](#adminlayout)
4. [The form pattern](#the-form-pattern)
5. [Flash messages](#flash-messages)
6. [Money, weights and pieces](#money-weights-and-pieces)
7. [Components](#components)
8. [CSS helper classes](#css-helper-classes)
9. [Words (`strings.ts`)](#words-stringsts)
10. [Browser behaviour (`client/`)](#browser-behaviour-client)
11. [Status chip contract](#status-chip-contract)
12. [Look and accessibility rules](#look-and-accessibility-rules)
13. [Testing a screen](#testing-a-screen)
14. [Shared files and parallel work](#shared-files-and-parallel-work)

## Files

| File | What it is |
|---|---|
| `AdminLayout.astro` | The page frame: side nav (desktop), bottom tab bar + "More" sheet (phone), status chip, flash, login-expired banner, confirm dialog, the admin script. |
| `admin.css` | All admin styles. Tokens copied from `src/styles/global.css` (the public CSS is never imported). |
| `components/*.astro` | Building blocks (inputs, tables, chips, charts …), listed under [Components](#components). |
| `forms.ts` | Reads form posts safely: text, ints, paise, grams, booleans, dates, choices, `_action`, `version`, `_key`. |
| `flash.ts` | Flash messages across the 303 redirect (URL key or cookie). |
| `format.ts` | Display helpers: `inr`, `int`, `pct`, `kg`, `kgInput`, `packGrams`, `jarEquivalents`, `pieces`, IST dates, ages, date ranges. |
| `parse.ts` | The typed-text parsers shared by `forms.ts` and the browser (`parsePaiseText`, `parseGramsText`, `parseIntText`, `cleanText`). |
| `status.ts` | Which words and tone each status chip gets (orders, products, stock, payment, batches, availability, source). |
| `nav.ts` | The list of screens (drives side nav, tab bar and More sheet), `canOpen(role, key)`, `navKeyForPath()`. |
| `strings.ts` | Every word the admin shows (English; Tamil-ready keys). |
| `icons.ts` | Inline SVG icons (no icon library). |
| `chart.ts` | Maths for the inline SVG bar chart. |
| `client/` | The one browser script: confirm dialog, drafts, login-expiry check, status chip, small enhancements. |

Everything runs on demand in workerd. Nothing here may load anything from another host.

## A screen in 30 lines

`src/pages/admin/harvests/index.astro` (URL `/admin/harvests/`; URLs always end in `/`):

```astro
---
export const prerender = false; // every admin page, always (a test checks it)

import { env } from 'cloudflare:workers';
import AdminLayout from '../../../admin/AdminLayout.astro';
import DateInput from '../../../admin/components/DateInput.astro';
import GramsInput from '../../../admin/components/GramsInput.astro';
import Icon from '../../../admin/components/Icon.astro';
import { failureFlash, redirectWithFlash, takeFlash, type Flash } from '../../../admin/flash';
import { dayIST } from '../../../admin/format';
import { newFormKey, readForm, type FormReader } from '../../../admin/forms';
import { t } from '../../../admin/strings';
import { addHarvest } from '../../../server/stock'; // business logic lives in src/server/*.ts

const admin = Astro.locals.admin!; // set by src/middleware.ts on every signed-in admin request
const SELF = '/admin/harvests/';
let form: FormReader | null = null;
let errors: Record<string, string> = {};
let flash: Flash | null = null;

if (Astro.request.method === 'POST') {
  form = await readForm(Astro.request);
  if (!form) return redirectWithFlash(Astro, SELF, { key: 'form.unreadable' });
  if (form.action(['add'] as const) !== 'add') return redirectWithFlash(Astro, SELF, { key: 'form.unknownAction' });
  const grams = form.grams('kg', { required: true, nonZero: true });
  const day = form.date('day', { required: true, max: dayIST() });
  if (form.ok) {
    const r = await addHarvest(env, admin, { grams: grams!, day: day!, key: form.key() });
    if (r.ok) return redirectWithFlash(Astro, SELF, { key: 'flash.added' });
    if (!form.takeFailure(r, ['kg', 'day'])) return redirectWithFlash(Astro, SELF, failureFlash(r));
  }
  errors = form.messages();
  flash = { tone: 'error', text: t('form.fixErrors') };
  Astro.response.status = 422; // the same page again, with what was typed
} else {
  flash = takeFlash(Astro); // before any HTML: it clears the flash cookie
}
const today = dayIST();
---
<AdminLayout title={t('nav.harvests')} active="harvests" flash={flash}>
  <form class="card" method="post" data-draft="harvest-new">
    <input type="hidden" name="_key" value={form?.key() ?? newFormKey()} />
    <GramsInput name="kg" label="Harvest" raw={form?.raw('kg')} packs={[250, 100]} required error={errors.kg} />
    <DateInput name="day" label="Harvest date" value={form ? form.raw('day') : today} max={today} required error={errors.day} />
    <div class="form-actions">
      <button class="btn btn-primary" name="_action" value="add"><Icon name="plus" />{t('common.add')}</button>
    </div>
  </form>
</AdminLayout>
```

(The function name and arguments of `addHarvest` are only an example; use the real ones from `src/server/README.md`.
The real screen also takes its words from strings, see [Words](#words-stringsts).)

Rules this shows:
- `export const prerender = false` on every admin page.
- POST is handled in the frontmatter **before** any HTML: read with `readForm`, act through `src/server/*`, then
  `redirectWithFlash(…)` (always a **303**), or render the same page with **422** and the errors.
- GET calls `takeFlash(Astro)` and passes the result to the layout.
- Server functions get `env` from `cloudflare:workers` and the actor from `Astro.locals.admin`.

## AdminLayout

```astro
<AdminLayout title="Orders" active="orders" flash={flash} subtitle="12 new" back={{ href: '/admin/orders/' }}>
  <a slot="actions" class="btn btn-primary" href="/admin/orders/new/"><Icon name="plus" />New order</a>
  …page…
</AdminLayout>
```

| Prop | Use |
|---|---|
| `title` (required) | The `<h1>` and the tab title ("Orders · Beezy Admin"). |
| `active` | The nav key to highlight (`nav.ts` `NavKey`). Left out, it is guessed from the URL (`/admin/orders/12/` → `orders`). |
| `flash` | From `takeFlash(Astro)`, or your own `{ tone, text }`. Left out, a `?flash=<key>` in the URL is shown (without clearing the cookie). Pass `null` for none. |
| `back` | `{ href, label? }`: a "Back" link above the title (detail pages). |
| `subtitle` | One line under the title. |
| `wide` | No max width (big grids such as Prices or Count all). |
| `bare` | Login page mode: no menus, no status chip, no status requests, a centred card. See `/admin/styleguide/?bare=1`. |
| `hideTitle` | The page draws its own heading (still pass `title` for the browser tab). |

Slots: default (the page), `actions` (buttons beside the title; they wrap under it on phones), `head` (extra `<head>` tags).

What the layout gives every page: the skip link, side nav on screens ≥ 900 px wide, the bottom tab bar
(Today · Orders · Stock · Products · More; helpers see Harvests instead of Products) and the "More" sheet on phones,
the website status chip, the login-expired banner, one shared confirm dialog, the logout form (POST `/admin/logout/`),
`<html class="js|no-js">`, `noindex`, and the self-hosted fonts (Mukta Malar 400/700 for everything, Bodoni Moda 500
for page titles).

**Who may open a screen.** Owner-only screens (`ownerOnly` in `nav.ts`: Products, Prices, Website, Activity, People,
Backup) are hidden from helpers in the menus, but the page must still refuse them:

```ts
import { canOpen } from '../../../admin/nav';
if (!canOpen(Astro.locals.admin?.role, 'prices')) return redirectWithFlash(Astro, '/admin/', { key: 'flash.forbidden' });
```

The `src/server/*` functions check roles again (`ownerOnly(actor)`), so this is about a friendly page, not security.

## The form pattern

Plain HTML forms that post to the **same URL** with an `_action` field, then a **303 redirect**. They work without
JavaScript. There are no CSRF tokens: the middleware checks `Sec-Fetch-Site` / `Origin` on unsafe methods, Astro's
`checkOrigin` covers form posts, and the session cookie is `SameSite=Strict`. So: never post to another host, and leave
`action` out (or set it to the page's own path).

```html
<form method="post" data-draft={`product-${p.id}`}>
  <input type="hidden" name="version" value={p.version} />   <!-- optimistic save: form.version() -->
  <input type="hidden" name="_key" value={newFormKey()} />    <!-- idempotency: form.key() -->
  …fields…
  <div class="actionbar">                                    <!-- sticky Save bar for long forms -->
    <button class="btn btn-primary" name="_action" value="save">Save</button>
    <ConfirmButton value="retire" tone="danger" message="Retire Murungai Honey? It leaves the website.">Retire</ConfirmButton>
  </div>
</form>
```

### Reading the post: `forms.ts`

`readForm(Astro.request, { maxBytes? })` returns a reader, or `null` (never throws) when the request is not a POST form,
is over 64 KB (default) or cannot be parsed. File parts are ignored: photos go through `/admin/api/media.json`.
`formReader(searchParams)` gives the same reader for GET filters (`formReader(Astro.url.searchParams)`).

Every reader returns a clean value or `null`, and records one error per field (the first one wins). Nothing throws.

| Call | Gives | Notes |
|---|---|---|
| `form.action(['save', 'confirm'] as const)` | the pressed button's `_action`, or `null` | No error is recorded; answer `form.unknownAction`. |
| `form.text(name, { required, max, min, multiline, pattern, patternError })` | cleaned text, `''` when empty | NFC, control and bidi characters removed, trimmed; line breaks become spaces unless `multiline`. `max` counts code points. |
| `form.optText(name, opts)` | text or `null` | For optional columns. |
| `form.int(name, { required, min, max })` | whole number or `null` | Accepts `1,200` and `−3`; refuses decimals. |
| `form.ints(name, opts)` | `number[]` | Repeated fields (a qty per line); empty ones are skipped. |
| `form.paise(name, { required, min, max, allowNegative, nonZero })` | **paise** or `null` | `'₹1,050.50'` → `105050`, `'350'` → `35000`. Default range ₹0 to ₹1 crore. `min`/`max` are in paise. |
| `form.grams(name, { required, min, max, allowNegative, nonZero, unit })` | **grams** or `null` | Bare numbers are kg: `'99.5'` → `99500`; `'500 g'`, `'1.5 kg'` also work. `unit: 'g'` makes bare numbers grams. |
| `form.bool(name)` | `true` / `false` | Last value wins (the Toggle sends a hidden `0`, then `1` when on). Missing → `false`. |
| `form.date(name, { required, min, max })` | `'YYYY-MM-DD'` or `null` | Real calendar days only. |
| `form.month(name, opts)` | `'YYYY-MM'` or `null` | From `<input type="month">`. |
| `form.choice(name, allowed, { required })` | one allowed value or `null` | Anything else is an error. |
| `form.choices(name, allowed)` | allowed values, no repeats | Checkbox groups. |
| `form.version(name = 'version')` | whole number ≥ 1 or `null` | The record version for optimistic saves. |
| `form.key(name = '_key')` | lower-case UUID or `null` | Pair with `newFormKey()` in the hidden input. |
| `form.raw(name)` / `rawAll(name)` / `has(name)` | what was typed | For refilling the form after an error. |
| `form.fail(field, key, vars?)` | — | Your own rule, with a `form.*` key from `strings.ts`. |
| `form.failText(field, text)` | — | Ready words (e.g. a server message). |
| `form.takeFailure(failure, fields)` | `true` if placed | Puts a `src/server` failure (`{ ok: false, error, message, field? }`) on its field when `field` is one of `fields`; otherwise returns `false` and you flash it with `failureFlash(failure)`. |
| `form.ok` / `form.errors` / `form.messages()` | — | `messages()` gives `{ field: 'words' }`, ready for the components' `error` prop. |

The same parsers are exported for other uses: `parsePaiseText`, `parseGramsText`, `parseIntText`, `cleanText`,
`textLength`, `isIsoDay`.

### After reading

1. **Success** → call `src/server/*`, then `return redirectWithFlash(Astro, SELF, { key: 'flash.saved' })`. Redirect back
   to the same page when you can (it clears the form's draft, see [Drafts](#drafts)).
2. **Server said no** (`r.ok === false`) → `form.takeFailure(r, [...fields])` to show it on a field and render with 422,
   or `return redirectWithFlash(Astro, SELF, failureFlash(r))`. `conflict` (someone saved first) becomes a "check" flash.
3. **Typing mistakes** (`!form.ok`) → render the same page with `Astro.response.status = 422`,
   `errors = form.messages()`, `flash = { tone: 'error', text: t('form.fixErrors') }`, and refill the fields with what
   was typed: `MoneyInput raw={form.raw('price')}`, `GramsInput raw={…}`, `TextField value={form.raw('name')}`.
   Never redirect here: the typed text would be lost.

Unknown `_action`, unreadable form → redirect with `form.unknownAction` / `form.unreadable`.
A missing record → redirect to the list with `flash.notFound`.

The style guide's "Form pattern (live)" section does all of this for real; try `35O` as a price.

## Flash messages

The one-line notice at the top of the page after a redirect. Tones: `ok` (green), `info` (blue), `warn` ("Please check",
amber), `error` (red, announced at once with `role="alert"`).

```ts
import { failureFlash, redirectWithFlash, takeFlash } from '../../../admin/flash';

return redirectWithFlash(Astro, SELF, { key: 'flash.saved' });                      // ?flash=flash.saved
return redirectWithFlash(Astro, SELF, { key: 'flash.publishQueued' });               // info tone from the key
return redirectWithFlash(Astro, SELF, { tone: 'warn', text: `Stock is now ${kg(-2000)} for Murungai honey, recount soon.` });
return redirectWithFlash(Astro, SELF, failureFlash(result));                         // a src/server failure
```

- A core key with no placeholders (`flash.*` or `form.*` in `strings.ts`) travels in the URL. Only those keys are
  accepted, so a crafted link can never show made-up text. The browser removes `?flash=` from the address bar after
  showing it, so a reload does not repeat it.
- Anything else (ready text, values, a changed tone) goes in an HttpOnly, `SameSite=Strict` cookie `bz_flash`
  (path `/admin/`, 2 minutes).
- `takeFlash(Astro)` reads and clears the cookie (or reads the URL key). Call it in the frontmatter, before any HTML is
  sent, and pass the result as `flash`.
- `location` must be a same-site path (`/admin/…`); anything else falls back to `/admin/`.

For notices that stay on the page (not after a save), use `<p class="notice notice-warn"><Icon name="alert" /><span>…</span></p>`
(tones `notice-info|ok|warn|bad`).

## Money, weights and pieces

**Money is integer paise everywhere** (contract 6). People type rupees; screens never do float maths on rupees.

| Job | Use |
|---|---|
| Show an amount | `inr(paise)` → `'₹1,05,000'`, `'₹1,050.50'`; `null` → `'—'` (from `src/lib/money.ts`, so it matches the website) |
| Edit an amount | `<MoneyInput name="price" paise={v.pricePaise} />` |
| Read it back | `form.paise('price', { min: 100 })` → paise |
| ₹ per 100 g, amount in words | `perHundredGrams`, `amountInWords` from `src/lib/money.ts` |

**Honey stock is grams; the owner sees kg with one decimal** (amendment A3). Candles and sticks are pieces.

| Job | Use |
|---|---|
| Show honey | `kg(99500)` → `'99.5 kg'` (display only, rounds to 1 decimal; negatives `'-2.0 kg'`) |
| Rough jar count | `jarEquivalents(99000, [250, 100])` → `'≈ 396 × 250 g or 990 × 100 g'` |
| Edit honey | `<GramsInput name="on_hand" grams={pool.onHand} packs={[250, 100]} />` (shows `= 99,500 g · ≈ 398 × 250 g …` live) |
| Read it back | `form.grams('on_hand')` → grams (`'99.5'` → `99500`, `'500 g'` → `500`) |
| Value for a kg input yourself | `kgInput(grams)`: one decimal when exact, otherwise every gram (`99550` → `'99.55'`), so saving an untouched form never changes the grams |
| Pieces | `pieces(12)` → `'12 pieces'`; edit with `QtyStepper` (or `TextField inputmode="numeric"`) and `form.int()` |
| Pack size | `packGrams(250)` → `'250 g'`, `packGrams(1000)` → `'1 kg'` |
| Pool levels | `src/lib/availability.ts` (`packAvailability`, `poolLevel`) is the shared rule; show the result with `<Badge kind="stock" value={level} />` |

Other formatting (`format.ts`): `int(105000)` → `'1,05,000'`; `pct(0.125)` → `'12.5%'`; `dateIST(iso)` →
`'15 Nov 2026'`; `dayMonthIST`, `timeIST` (`'10:42 am'`), `dateTimeIST`; `monthLabel('2026-11')` → `'Nov 2026'`;
`ageShort(iso)` → `'5 min'`, `'3 h'`, `'2 days'`; `dayIST()` (today in IST), `addDays`, `isDay`;
`rangeFor('thisFy')` → `{ from: '2026-04-01', to: '2027-03-31' }` (presets `today`, `last7`, `thisMonth`,
`lastMonth`, `thisFy`, `lastFy`, `thisYear`). Stored times are UTC ISO; everything shown is IST.

## Components

Import from `src/admin/components/`. Every field component takes `name`, `label`, `hint`, `error` (words from
`form.messages()`), `optional` (adds "(optional)"), `labelHidden` (label for screen readers only, for grids),
`disabled`, `id` (made from the name when left out) and `class`. Each one renders label, hint, control and error
linked with `aria-describedby`.

### Fields

| Component | Example | Posts | Read with |
|---|---|---|---|
| `TextField` | `<TextField name="tagline" label="Tagline" value={p.tagline} max={140} counter />` | text | `form.text()` |
| `TextField multiline` | `<TextField name="about" label="About" multiline rows={6} value={p.about} />` | text with line breaks | `form.text(name, { multiline: true })` |
| `MoneyInput` | `<MoneyInput name="price" label="Price" paise={v.price} allowEmpty hint={t('money.emptyMeansWhatsApp')} />` | rupees as typed | `form.paise()` |
| `GramsInput` | `<GramsInput name="kg" label="Honey left" grams={pool.onHand} packs={[250, 100]} />` | kg as typed | `form.grams()` |
| `QtyStepper` | `<QtyStepper name={`qty_${l.id}`} label="Quantity" value={l.qty} min={1} max={99} />` | whole number | `form.int(name, { min: 1, max: 99 })` |
| `Select` | `<Select name="variant" label="Pack" value={id} placeholder="Pick a pack" groups={…} />` | the option value | `form.choice()` / `form.int()` |
| `Select autosubmit` | filters: sends its GET form when changed; a "Show" button appears without JS | | |
| `Combobox` | `<Combobox name="courier" label="Courier" options={['India Post', 'DTDC']} />` | free text with suggestions | `form.text()` |
| `Toggle` | `<Toggle name="show_prices" label="Show prices on the website" checked={s.showPrices} />` | `0` then `1` when on | `form.bool()` |
| `PhotoPicker` | `<PhotoPicker name="photo" label="Main photo" photos={library} selected={p.photo} />` | the chosen `path`(s) | `form.text()` / `form.rawAll()` |
| `DateInput` | `<DateInput name="packed_on" label="Packed on" value={day} max={dayIST()} />` (`type="month"` for a month) | `'YYYY-MM-DD'` | `form.date()` / `form.month()` |
| `DateRange` | `<DateRange url={Astro.url} from={from} to={to} presets={['thisMonth', 'lastMonth', 'thisFy']} />` | its own GET form `?from=&to=` | `formReader(Astro.url.searchParams).date('from')` |
| `Field` | wraps your own control: `<Field id={id} label="…" error={e}><input id={id} aria-describedby={describedBy(id, hint, e)} …/></Field>` | | |

Details:
- `MoneyInput`: `raw` (what was typed, wins over `paise`, for the 422 refill), `allowEmpty` (placeholder "Price on
  WhatsApp"), `small` (compact, for tables), `required`. The browser regroups `1050` to `1,050` when the box loses focus.
- `GramsInput`: `raw`, `packs` (pack sizes in grams for the jar hint), `allowNegative` (adjustments; the keyboard then
  has a minus key), `small`, `placeholder`.
- `TextField`: `type` (`text|email|tel|search|url|password`), `max` (also `maxlength`; the server must check again),
  `counter` (live "12 / 140"), `inputmode`, `autocomplete` (default `off`), `pattern` (browser hint only), `list`,
  `readonly`, `noDraft` (keep out of the browser draft).
- `Select`: `options` (`{ value, label, disabled? }[]`) or `groups` (`{ label, options }[]`), `placeholder` (an empty
  first choice), `required`. It is the phone's own picker, which is the best on Android.
- `Toggle`: a checkbox with `role="switch"`; the whole row is the tap target. `offValue={null}` sends nothing when off.
  A **disabled** toggle sends nothing at all, so `form.bool()` reads `false`: do not save a disabled toggle's field.
- `PhotoPicker`: `photos` (`{ path, src, alt, width?, height? }[]`, thumbnails from the same origin), `multiple`
  (checkboxes), `noneLabel` (adds a "No photo" choice posting `''`), `uploadable` (the upload tile; disabled without
  JavaScript; the page script calls `initPhotoUploads()` from `src/admin/catalog/upload.ts`, which switches it on and
  adds new photos to `[data-photo-grid]`; pass `uploadable={false}` on pages that do not). It also posts `<name>__shown=1`, so
  `form.has('gallery__shown')` tells "nothing ticked" apart from "picker not on the form".
- `DateInput`: the phone's own date picker; `min` / `max` in the same format as the value (the server checks again
  with `form.date(name, { min, max })`).
- `DateRange`: keeps the other query parameters of `url` (filters) and drops `page`; `nameFrom` / `nameTo` rename the
  fields; `presets={false}` for none; `error` for "To is before From" (`t('range.backwards')`).

### Buttons and dialogs

```html
<button class="btn btn-primary" name="_action" value="save">Save</button>
<ConfirmButton value="cancel" tone="danger" icon="close" message="Cancel order BZ-7K3QD? The stock goes back." confirmLabel="Yes, cancel it">Cancel order</ConfirmButton>
```

- Button classes: `btn` (default, outlined), `btn-primary` (dark, the main action), `btn-honey`, `btn-danger`,
  `btn-quiet` (no border), `btn-icon` (square, give it `aria-label`), `btn-lg` (56 px), `btn-block` (full width).
  Put an `<Icon />` first for an icon.
- `ConfirmButton`: a submit button that asks first. Props: `value` (the `_action`), `message` (the question), `title`,
  `confirmLabel` (the yes button; say what happens: "Retire", "Yes, cancel it"), `tone` (`danger` makes the yes button
  red), `name` (default `_action`), `size`, `block`, `icon`, `formaction`, `form`, `disabled`. Without JavaScript it
  simply submits, so the server must accept the action as it is.
- Any submit button or form can ask with attributes: `data-confirm="Question?"`, `data-confirm-title`,
  `data-confirm-ok`, `data-confirm-tone="danger"`. Links too: `<a href="…" data-confirm="…">` (rare; most actions are
  forms). In scripts: `import { askConfirm } from '../../admin/client/confirm'` → `await askConfirm({ message })`.
- The dialog itself (`ConfirmDialog`) is rendered once by the layout. "Go back" has focus first, so Enter never
  confirms by accident.

### Showing data

| Component | Example |
|---|---|
| `Badge` | `<Badge kind="order" value={o.status} />`, `<Badge kind="stock" value="low" />`, `<Badge tone="warn" text="Customer saw a different price" />` |
| `DataTable` | see below |
| `StatTile` | `<StatTile label="Net sales" paise={now.net} prev={last.net} period="last month" href="/admin/sales/" />` |
| `BarChart` | `<BarChart caption="Sales per month" format="money" highlight={11} data={months.map((m) => ({ label: 'Nov', title: 'Nov 2026', value: m.netPaise }))} />` |
| `EmptyState` | `<EmptyState icon="orders" title="No new orders" text="Orders from the website show up here."><a class="btn btn-primary" href="/admin/orders/new/">New order</a></EmptyState>` |
| `Tabs` | `<Tabs label="Order filters" items={[{ href: '/admin/orders/?f=new', label: 'New', count: 3, current: f === 'new' }, …]} />` |
| `Pagination` | `<Pagination url={Astro.url} page={page} pages={pages} />` or `hasNext={rows.length > PAGE}`; `prevHref`/`nextHref` for cursor paging |
| `FlashMessage` | rendered by the layout; use it yourself only for a second, inline notice |
| `Icon` | `<Icon name="orders" />`, `label="…"` when the icon alone carries meaning; names in `icons.ts` (shown in the style guide) |

**Badge kinds** (words from `strings.ts`, tones from `status.ts`): `order` (`new`, `confirmed`, `packed`, `shipped`
"Sent", `delivered`, `cancelled`, `spam` "Not a real order"), `product` (`draft`, `live` "On website", `paused`,
`retired`), `stock` (`in`, `low`, `out`, `negative` "Below zero, recount", `untracked` "Not counted yet"), `payment`
(`paid`, `part`, `unpaid`, `refunded`; work it out with `paymentState(totalPaise, paidPaise)`), `batch` (`active`,
`finished`, `recalled`), `avail` (`auto`, `in` "Always available", `out` "Sold out (by hand)"), `source` (`cart`,
`product`, `gift`, `manual`, `pasted`). An unknown value shows itself in a neutral chip. Colour is never the only
signal: every chip has words, and the red tone adds an icon.

**DataTable**: a table on wide screens, one card per row on phones (each cell gets its column name as a label).

```astro
<DataTable caption="New orders" columns={[
  { key: 'ref', label: 'Order', primary: true },        // card title; links to row.href (whole row tappable)
  { key: 'age', label: 'Waiting', type: 'age' },        // ISO time → '5 min'
  { key: 'total', label: 'Total', type: 'money' },      // paise → ₹, right-aligned, red when negative
  { key: 'status', label: 'Status', type: 'badge' },    // { kind, value } or { tone, text }
]} rows={orders.map((o) => ({ href: `/admin/orders/${o.id}/`, ref: o.ref, age: o.createdAt, total: o.totalPaise,
  status: { kind: 'order', value: o.status }, tone: o.ageHours > 24 ? 'warn' : undefined }))} empty="No new orders." />
```

Column `type`: `text` (default), `money` (paise), `int`, `grams` (→ kg), `pct` (fraction), `date`, `datetime`, `age`,
`badge`. Options: `align`, `hideLabel` (no label in the phone card). A cell may also be `{ text, href }`. Row `tone`:
`bad` (red edge, e.g. negative stock), `warn`, `muted` (cancelled). Table props: `caption` (`captionHidden` keeps it
for screen readers only), `empty`, `noCards` (stay a scrolling table on phones, for wide grids), `now` (for tests).
For inputs inside cells (Prices grid, Count all), write the table by hand with the same classes:

```html
<div class="table-wrap has-cards">            <!-- drop has-cards to keep a scrolling table on phones -->
  <table class="dtable">
    <caption>Count all</caption>
    <thead><tr><th scope="col">Pool</th><th scope="col" class="end">Now</th><th scope="col">Counted</th></tr></thead>
    <tbody>
      <tr class="tone-row-bad">
        <td class="is-primary" data-label="Pool">Sunflower honey</td>
        <td class="end neg" data-label="Now">-2.0 kg</td>
        <td data-label="Counted"><GramsInput small labelHidden name={`count_${id}`} label="Counted Sunflower honey" /></td>
      </tr>
    </tbody>
  </table>
</div>
```

**StatTile**: `value` (text or a number with Indian grouping), `paise` (→ ₹), `grams` (→ kg); `prev` (same unit) works
out "▲ 12% vs last month", or pass `change` as a fraction; `better="down"` when falling is good (refunds, discounts),
`better="none"` to keep it neutral; `period` (default "last month"); `hint`; `href` makes the tile a link; `alert` makes
it red. A `prev` of 0 shows "New since last month". Put tiles in `<div class="tiles">`.

**BarChart**: `format` (`money` = paise, `grams`, `int`), `highlight` (index of the bar to stand out), `height` (px,
default 180), `maxLabels` (`{ phone: 6, desktop: 14 }`), `emptyText` (shown when every value is 0). Each point is
`{ label, value, title? }`. Bars scale to a "nice" top; labels thin out on phones; a hidden table carries every value
for screen readers; hovering a bar shows its value. No chart library.

## CSS helper classes

All in `admin.css`; never import `src/styles/global.css`. Page-specific styles go in the page's own `<style>` block and
use the tokens (`var(--honey)`, `var(--line)` …).

| Class | Use |
|---|---|
| `section` + `section-head` / `section-title` / `section-link` | A block of the page with its `<h2>` and an optional "See all" link on the right |
| `card` | White box with padding and a soft shadow |
| `stack` | Vertical spacing between children |
| `row`, `row-between` | Wrapping horizontal row with gaps; `row-between` spreads the ends |
| `grid-2`, `grid-3` | As many columns as fit (each at least 280 px / 210 px wide), so one column on phones |
| `tiles` | Grid for `StatTile`s (at least 156 px each: two per row on a phone) |
| `form-actions` | Row of buttons at the end of a short form |
| `actionbar` | Sticky bar at the bottom (above the phone tab bar) for the Save button of long forms |
| `switch-list` | Stack of `Toggle`s with dividers |
| `kv` | `<dl class="kv"><dt>Order</dt><dd>BZ-7K3QD</dd>…</dl>`: label/value pairs |
| `linklist` | `<ul class="linklist"><li><a href>…<Badge …/></a></li>`: tappable rows (alerts, settings); `linklist-row` for a row that is not a link |
| `chips` + `chip` | Small link pills (quick filters); `aria-current="true"` marks the chosen one |
| `notice notice-info|ok|warn|bad` | A lasting notice on the page (icon + `<span>` text) |
| `muted` | Secondary text colour (still AA) |
| `num` | Tabular figures so amounts line up |
| `neg` | Red, bold: negative amounts and stock |
| `nowrap` | Keep on one line |
| `sr-only` | For screen readers only |
| `field-label`, `field-hint`, `field-error`, `input`, `fieldset` | Field parts, when you build a control by hand |

Breakpoints: below 700 px `DataTable`s turn into cards and cards get less padding; from 900 px the side nav replaces
the tab bar; from 560 px the status chip shows its long words. Grids flow by the space available. Print hides the menus,
the flash and the action bar.

## Words (`strings.ts`)

Every word the owner sees comes from strings, so Tamil can be added later without touching screens (amendment A5:
English only for now).

```ts
import { t } from '../../../admin/strings';
t('common.save');                                   // 'Save'
t('today.toCollect', { amount: inr(128000) });      // '₹1,280 to collect'
```

- Core words (navigation, buttons, form errors, statuses, flash messages, component labels) are in `EN` in
  `src/admin/strings.ts`. A missing placeholder value stays visible as `{name}`, which is easy to spot.
- **Your screen's own words go in their own file**, so two screens never edit the same file:

  ```ts
  // src/admin/strings/orders.ts
  import { defineStrings } from '../strings';
  export const S = defineStrings({
    'orders.title': 'Orders',
    'orders.empty': 'No orders match these filters.',
    'orders.sawPrice': 'Customer saw {shown}, today’s price {now}',
  });
  // in the page: S.t('orders.title'), S.t('common.save') (core keys work too)
  ```

  An area key must not repeat a core key (an error is thrown at import time, so a unit test catches it). Prefix keys
  with the area name.
- Flash keys that should travel in the URL (`?flash=`) must be **core** keys starting with `flash.` and have no
  placeholders. For anything else use `{ text, tone }` (cookie).
- Words the browser script needs are listed in `CLIENT_KEYS` and sent to the page as JSON; nothing else ships to the
  browser.
- Style: plain, short, friendly English for a non-technical owner on a phone. Say what happens ("Stock goes back"),
  not how. Money as ₹ with Indian grouping; weights in kg.

## Browser behaviour (`client/`)

One script, bundled by Astro from the layout (about 17 KB minified, 6.5 KB gzip; no third-party code). Every page works without it.
Hooks you can use in your markup:

| Markup | Effect |
|---|---|
| `data-confirm="Question?"` on a submit button, form or link | Asks first in the shared dialog (also `data-confirm-title`, `data-confirm-ok`, `data-confirm-tone="danger"`). |
| `<form data-draft="product-12">` | Draft saving, below. |
| `data-no-draft` on a field or a wrapper | Never stored in the draft (hidden, password and file inputs never are). |
| `data-no-guard` on a form | Skip the login check before sending. |
| `data-no-once` on a form | Do not disable its buttons after sending (e.g. a download). |
| `data-autosubmit` on a `<select>` | Sends its form on change (`Select autosubmit` sets it). |
| `data-money`, `data-grams`, `data-counter`, `data-stepper` | Set by `MoneyInput`, `GramsInput`, `TextField counter`, `QtyStepper`. |

**Sending a form.** When any admin form is sent: (1) a `data-confirm` question is asked first; (2) for POST forms, if the
login was last confirmed over a minute ago, a quick `GET /admin/api/status.json` checks it, and if it has expired the
send is held (the typed text stays, the draft is saved, the banner shows); (3) the buttons are disabled against double
taps and the pressed one says "Saving…" (released after 12 s or on Back). The pressed button's `name`/`value`
(`_action`) is always kept.

**Drafts.** A `<form data-draft="<unique key>">` keeps what was typed in this browser's localStorage, so a dropped
connection, an expired login or a closed tab never loses work. Use a key per record (`product-12`, `order-55-lines`),
and put the record's `version` in a hidden input named `version`.
- Saved half a second after typing stops, and at once when a send is held.
- On the next visit, a bar offers "Bring them back" / "Throw away" when the draft differs from the page. If the
  record's `version` changed meanwhile, the bar warns that someone saved in between.
- A draft is removed after a successful save that comes back to the page with an `ok` flash, or when it matches the
  page. Drafts older than 7 days are removed.
- Only for long forms (product editor, order lines, Count all, Prices). Not for filters or one-button forms.

**Login expired.** `GET /admin/api/status.json` answering 401/403, redirecting to `/admin/login/`, or returning HTML
means the login expired. The banner "Login expired — tap to sign in again" opens `/admin/login/?next=<this page>` in a
new tab, so nothing on this page is lost; coming back to the tab re-checks and shows "You are signed in again. You can
save now." Network errors, 404 and 5xx are "unknown" and never block anything.

**Your own page script.** Add a `<script>` in the page (Astro bundles it; keep it tiny, no libraries). Useful
imports: `$`, `$$`, `fire` from `src/admin/client/dom.ts`, `askConfirm` from `client/confirm.ts`. A script that sends a
form itself (fetch) must call `event.preventDefault()`; the shared submit handler then stays out of the way.
Events: `bz:submitted` and `bz:hold` on `document` (`detail.form`).

## Status chip contract

The chip in the top bar starts neutral ("Website") and is filled from `GET /admin/api/status.json`, which the
publish/ops agent writes. It polls every 20 s while an update is running or waiting, otherwise every 2 minutes, only
while the tab is visible, and fails silently.

```jsonc
// 200, content-type application/json, Cache-Control: no-store
{
  "website": {
    "state": "up_to_date" | "updating" | "waiting" | "failed" | "off",
    "at": "2026-11-15T05:12:00Z" | null   // up_to_date: when it went live; updating: when it started; waiting: when it will run
  }
  // any other top-level fields are ignored by the chip
}
```

`website` may also simply be `getPublishStatus()` from `src/server/publish.ts` as it is: `disabled` reads as `off`, and
without `at` the time comes from `last.liveAt` / `last.requestedAt` (up to date), `last.requestedAt` (updating) or
`dueAt` (waiting). Words: "Website up to date ✓ (10:42 am)", "Updating… started 2 min ago", "Changes waiting, update
at 11:05 am", "Update didn't finish", "Publishing is off on this computer" (short forms on phones). The chip links to
`/admin/website/`.

When the login has expired, the endpoint must answer **401/403** (or redirect to `/admin/login/`), never 200 JSON.

## Look and accessibility rules

- **Phone first.** Check every screen at 390 × 844 first, then 1440 × 900. No sideways scrolling (wide grids go in
  `table-wrap`, which scrolls by itself).
- **16 px minimum** for all text (body is 17 px). **48 px minimum** tap targets: every `.btn`, input, select, tab,
  chip, nav item and table row link already is; links inside sentences are the only exception.
- **Contrast** (WCAG AA, measured):

  | Pair | Ratio |
  |---|---|
  | text `--choc` #2B1A10 on cream #FBF3E6 | 15.2 |
  | secondary `--ink-2` #5E4A3A on cream | 7.6 |
  | links `--link` #8A4A06 on cream | 6.2 |
  | primary button: cream on choc | 15.2 |
  | honey button: choc on `--honey` #E08A12 | 6.2 |
  | danger button: white on `--bad` #B42318 | 6.6 |
  | chips: ok 5.8, warn 6.6, bad 5.8, info 5.6, honey 7.3, muted 6.8, neutral 8.3 | ≥ 4.5 |
  | flash / notice text on its tint | 6.6–9.3 |
  | `--ink-3` #8A7562 on cream (borders only, never text) | 4.0 |

  New colours must reach 4.5:1 for text and 3:1 for borders of controls.
- **Colour is never the only signal**: statuses have words, negatives also have a minus sign, errors have an icon and
  text.
- Every control has a visible label (`labelHidden` only inside grids whose column header says it). Errors are linked
  to their field (`aria-describedby`, `aria-invalid`).
- Fonts: Mukta Malar (body, Tamil-capable) and Bodoni Moda (page titles), self-hosted through `@fontsource`. No other
  fonts, no icon fonts, no images for icons.
- No GSAP, Lenis, preloader or animation libraries. Motion is limited to small transitions and turned off with
  `prefers-reduced-motion`.
- Nothing from another host: no CDN, no analytics, no external images or fonts (a unit test greps for it).
- Nothing is hard-deleted from the admin: hide, pause, retire or cancel instead (design §5).

## Testing a screen

- **Unit tests** for your own helpers: `test/unit/<area>/*.test.ts` (Vitest, Node). `npm run test:unit`.
  The shell's own tests are in `test/unit/admin-shell/` (forms, flash, strings, nav, format, chart, client helpers,
  and static checks over `src/admin/**` and `src/pages/admin/**`: `prerender = false`, no third-party URLs, no
  public CSS/GSAP/Lenis, no personal emails, colour tokens match the public site).
- **Worker tests** for server logic: `test/worker/<area>/` (see `docs/DEV-NOTES.md`).
- **In a browser**: `npm run dev -- --port <your port> --host 127.0.0.1` with your own `BEEZY_STATE_DIR`, then open
  the page in headless Chrome at 390 × 844 and 1440 × 900. Check: no console errors, no requests to other hosts, no
  text under 16 px, no tap target under 48 px, no sideways scroll, the form works with JavaScript off. The style
  guide was checked this way.
- In `astro dev` the dev bypass signs you in as `DEV_ADMIN_EMAIL` (owner) on `localhost` / `127.0.0.1` only.

## Shared files and parallel work

These files are shared by every screen. Screen agents do **not** edit them; ask the integrator ("NEEDS: <file> —
<change>"):

- `AdminLayout.astro`, `admin.css`, `components/**`, `client/**`, `forms.ts`, `flash.ts`, `format.ts`, `parse.ts`,
  `status.ts`, `nav.ts`, `icons.ts`, `chart.ts`, `strings.ts`.

What each screen owns: its pages under `src/pages/admin/<area>/`, its words in `src/admin/strings/<area>.ts`, its
own page `<style>` and `<script>`, and its tests. If a core word is missing (a new flash key, a new status), use
`{ text, tone }` or an area string for now and list the core key you need. If an icon is missing, use the closest
existing one and list it.
