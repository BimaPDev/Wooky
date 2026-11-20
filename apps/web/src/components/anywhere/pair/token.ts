const TOKEN_KEY = "wooky.pair.token";

/** Device token this browser got from a host's `POST /pair`. Null on the host's own machine. */
export function loadPairedToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function savePairedToken(token: string): boolean {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function clearPairedToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}
