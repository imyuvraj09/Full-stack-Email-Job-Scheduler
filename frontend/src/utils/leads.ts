export function parseLeads(text: string) {
  const found =
    text.match(
      /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}\b/gi,
    ) || [];
  return [...new Set(found.map((email) => email.toLowerCase()))];
}
