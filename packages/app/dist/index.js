// src/app.ts
import { renderTaskBanner } from "@renx/toolkit";
var createAppOutput = () => {
  return renderTaskBanner("Ship ci");
};

// src/index.ts
console.log("App output:");
console.log(createAppOutput());
//# sourceMappingURL=index.js.map