export const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

export async function forwardToBackend(
  path: string,
  request: Request,
  init: RequestInit = {},
) {
  const authorization = request.headers.get("authorization");

  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();

  return new Response(text, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}
