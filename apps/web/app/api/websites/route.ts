import { forwardToBackend } from "../backend";

export async function GET(request: Request) {
  return forwardToBackend("/websites", request, {
    method: "GET",
  });
}

export async function POST(request: Request) {
  return forwardToBackend("/website", request, {
    method: "POST",
    body: await request.text(),
  });
}
