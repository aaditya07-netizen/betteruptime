import { forwardToBackend } from "../../backend";

export async function POST(request: Request) {
  return forwardToBackend("/user/signin", request, {
    method: "POST",
    body: await request.text(),
  });
}
