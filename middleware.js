/** Runs on Vercel before static files — protects the CDN-served public/ folder. */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function parseBasicAuth(header) {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

export default function middleware(request) {
  const expectedUser = process.env.AUTH_USER;
  const expectedPass = process.env.AUTH_PASSWORD;

  if (!expectedUser || !expectedPass) {
    return;
  }

  const creds = parseBasicAuth(request.headers.get("authorization"));
  if (creds?.user === expectedUser && creds?.pass === expectedPass) {
    return;
  }

  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Cursor Chat"',
    },
  });
}
