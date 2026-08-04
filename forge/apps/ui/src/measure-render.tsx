import { renderToStaticMarkup } from "react-dom/server";

import { ForgeApp } from "./app.js";

renderToStaticMarkup(
  <ForgeApp dependencies={[{ name: "api", status: "healthy" }]} />,
);
