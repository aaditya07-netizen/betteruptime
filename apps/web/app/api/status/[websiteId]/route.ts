import { forwardToBackend } from "../../backend";

type Context = {
  params: Promise<{
    websiteId: string;
  }>;
};

export async function GET(request: Request, context: Context) {
  const { websiteId } = await context.params;

  return forwardToBackend(`/status/${websiteId}`, request, {
    method: "GET",
  });
}
