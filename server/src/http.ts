export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

export function html(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init?.headers ?? {}) },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}
