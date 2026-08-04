import { createRoot } from "react-dom/client";

import { ForgeApp } from "./app.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error(
    "Forge UI could not mount: no #root element in the document.",
  );
}

createRoot(rootElement).render(
  <ForgeApp
    dependencies={[
      { name: "api", status: "healthy" },
      { name: "worker", status: "healthy" },
      { name: "queue", status: "unavailable", detail: "Awaiting local Redis." },
    ]}
  />,
);
