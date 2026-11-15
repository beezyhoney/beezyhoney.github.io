// "Please check these prices" before sending: a form with [data-risk-form] whose price inputs carry
// data-old="<paise or empty>" and data-risk-name="Murungai Honey 250 g". When a new price is more than 50 % away from
// the old one, or under ₹10, the owner confirms first; then a hidden confirm_big=1 goes with the form, so the server
// does not ask again. Without JavaScript the server asks instead (same rule, src/server/prices.ts riskOf).
import { askConfirm } from '../client/confirm';
import { $, $$ } from '../client/dom';
import { parsePaiseText } from '../parse';
import { formatINR } from '../../lib/money';
import { w } from './upload';

export function riskOfClient(oldPaise: number | null, newPaise: number | null): 'big' | 'low' | null {
  if (newPaise === null) return null;
  if (newPaise < 1000) return 'low';
  if (oldPaise !== null && oldPaise > 0 && Math.abs(newPaise - oldPaise) / oldPaise > 0.5) return 'big';
  return null;
}

export function initRiskCheck(): void {
  for (const form of $$<HTMLFormElement>('form[data-risk-form]')) {
    form.addEventListener('submit', (e) => {
      const flag = $<HTMLInputElement>('input[name="confirm_big"]', form);
      if (!flag || flag.value === '1') return;
      const lines: string[] = [];
      for (const input of $$<HTMLInputElement>('input[data-risk-name]', form)) {
        if (input.disabled) continue;
        const old = input.dataset.old ? Number(input.dataset.old) : null;
        const now = input.value.trim() ? parsePaiseText(input.value.trim()) : null;
        if (now === old) continue;
        const risk = riskOfClient(old, now);
        if (risk) lines.push(w('risk.line', { name: input.dataset.riskName || '', old: old === null ? '—' : formatINR(old), new: now === null ? '—' : formatINR(now), why: w(risk === 'big' ? 'risk.big' : 'risk.low') }));
      }
      if (!lines.length) return;
      e.preventDefault();
      const sub = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      void askConfirm({ message: w('risk.ask', { list: lines.join('\n') }), ok: w('risk.yes') }).then((ok) => {
        if (!ok) return;
        flag.value = '1';
        if (sub) form.requestSubmit(sub); else form.requestSubmit();
      });
    });
  }
}
