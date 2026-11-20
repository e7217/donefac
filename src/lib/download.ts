export function downloadText(filename: string, value: string, mime: string) {
  const url = URL.createObjectURL(new Blob([value], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
