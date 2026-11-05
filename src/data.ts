/** Files in public/data (or another public folder), relative to wherever the app is hosted. */
export function dataUrl(file: string, folder: "data" | "textures" = "data"): string {
  return `${import.meta.env.BASE_URL}${folder}/${file}`;
}
