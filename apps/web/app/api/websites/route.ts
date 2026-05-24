import { forwardToBackend } from "../backend";

export async function POST(request: Request) {
  return forwardToBackend("/website", request, {
    method: "POST",
    body: await request.text(),
  });
}
