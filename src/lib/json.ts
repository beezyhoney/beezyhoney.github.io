/** JSON for a <script type="application/json"> block: every `<` is escaped, so the data can never end the script */
export const toJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');
