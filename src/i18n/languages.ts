/**
 * Language metadata for supported locales. Eshlik ships Turkish (the
 * default) and English.
 *
 * To add a new language:
 * 1. Create a new folder: src/i18n/locales/{code}/translation.json
 * 2. Add an entry here with the language code, English name, and native name
 * 3. Optionally add a priority (lower = higher in dropdown, no priority = alphabetical at end)
 * 4. For RTL languages, add direction: 'rtl'
 */
export const LANGUAGE_METADATA: Record<
  string,
  {
    name: string;
    nativeName: string;
    priority?: number;
    direction?: "ltr" | "rtl";
  }
> = {
  tr: { name: "Turkish", nativeName: "Türkçe", priority: 1 },
  en: { name: "English", nativeName: "English", priority: 2 },
};
