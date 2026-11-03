/** Files in public/data, relative to wherever the app is hosted. */
export function dataUrl(file: string): string {
  return `${import.meta.env.BASE_URL}data/${file}`;
}
