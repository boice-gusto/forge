import { createRoot } from "react-dom/client";

import { ForgeApp } from "./app.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <ForgeApp
    dependencies={[
      { name: "api", status: "healthy" },
      { name: "worker", status: "healthy" },
      { name: "queue", status: "unavailable", detail: "Awaiting local Redis." },
    ]}
  />,
);
