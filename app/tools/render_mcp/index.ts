import { defineMcpSource } from "@render-factory/sdk";

export default defineMcpSource({
  name: "render",
  transport: "http",
  url: "https://mcp.render.com/sse",
  headers: () => ({
    Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
  }),
});
