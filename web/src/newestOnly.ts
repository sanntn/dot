// Hands out a check for each request. Only the newest request's check passes, so a slow earlier answer
// cannot overwrite a newer one. `invalidate` fails every check handed out so far, for a filter that changed.
export function newestOnly() {
  let latest = 0;
  return {
    next(): () => boolean {
      const mine = ++latest;
      return () => mine === latest;
    },
    invalidate(): void {
      latest++;
    },
  };
}
