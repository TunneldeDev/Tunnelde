export function validUpdateSource(value: string): boolean {
  if (
    value.length > 2048 ||
    /\s/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    ) ||
    value.split("{channel}").length !== 2
  )
    return false;
  try {
    const replaced = value.replace("{channel}", "tunnelde-update-channel");
    if (/[{}\\]/.test(replaced)) return false;
    const url = new URL(replaced);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      url.pathname.includes("tunnelde-update-channel") &&
      !url.hostname.includes("tunnelde-update-channel")
    );
  } catch {
    return false;
  }
}
