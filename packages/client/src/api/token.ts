const KEY = "hexcommand.token";

export function getToken(): string | null {
  try {
    const fromUrl = new URL(window.location.href).searchParams.get("token");
    if (fromUrl) {
      localStorage.setItem(KEY, fromUrl);
      const u = new URL(window.location.href);
      u.searchParams.delete("token");
      window.history.replaceState({}, "", u.toString());
      return fromUrl;
    }
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}
