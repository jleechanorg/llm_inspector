import fs from "fs";

function processCaptures(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  let totalBytes = 0;
  let totalToolBytes = 0;
  let totalSystemBytes = 0;
  let count = 0;

  for (const item of data) {
    if (item.totalBytes > 0) {
      totalBytes += item.totalBytes;
      count++;
      for (const comp of item.breakdown) {
        if (comp.component.startsWith("Built-in tool defs") || comp.component.startsWith("MCP tool defs")) {
          totalToolBytes += comp.bytes;
        }
        if (comp.component.startsWith("System prompt") || comp.component.includes("instructions")) {
          totalSystemBytes += comp.bytes;
        }
      }
    }
  }

  return {
    count,
    totalBytes,
    totalToolBytes,
    totalSystemBytes,
    avgBytes: Math.round(totalBytes / count),
    avgToolBytes: Math.round(totalToolBytes / count),
    avgSystemBytes: Math.round(totalSystemBytes / count),
    estTokens: Math.ceil(totalBytes / 3.5),
    avgTokens: Math.ceil((totalBytes / count) / 3.5),
    avgToolTokens: Math.ceil((totalToolBytes / count) / 3.5),
  };
}

const obs = processCaptures("/tmp/observer_captures.json");
const ond = processCaptures("/tmp/ondemand_captures.json");

console.log("=== TOKEN SAVINGS EXPERIMENT RESULTS ===");
console.log("\nObserver Mode (Without Proxy filtering):");
console.log(`  Total Requests: ${obs.count}`);
console.log(`  Average Request Size: ${obs.avgBytes.toLocaleString()} bytes (~${obs.avgTokens.toLocaleString()} tokens)`);
console.log(`  Average Tool Definitions: ${obs.avgToolBytes.toLocaleString()} bytes (~${obs.avgToolTokens.toLocaleString()} tokens)`);

console.log("\nOn-Demand + Lean Mode (With Proxy filtering):");
console.log(`  Total Requests: ${ond.count}`);
console.log(`  Average Request Size: ${ond.avgBytes.toLocaleString()} bytes (~${ond.avgTokens.toLocaleString()} tokens)`);
console.log(`  Average Tool Definitions: ${ond.avgToolBytes.toLocaleString()} bytes (~${ond.avgToolTokens.toLocaleString()} tokens)`);

const avgSavingsBytes = obs.avgBytes - ond.avgBytes;
const avgSavingsTokens = Math.ceil(avgSavingsBytes / 3.5);
const percentSavings = ((obs.avgBytes - ond.avgBytes) / obs.avgBytes * 100).toFixed(1);

const toolSavingsBytes = obs.avgToolBytes - ond.avgToolBytes;
const toolSavingsTokens = Math.ceil(toolSavingsBytes / 3.5);
const toolPercentSavings = ((obs.avgToolBytes - ond.avgToolBytes) / obs.avgToolBytes * 100).toFixed(1);

console.log("\n=== SUMMARY OF SAVINGS PER TURN ===");
console.log(`  Average Savings: ${avgSavingsBytes.toLocaleString()} bytes (~${avgSavingsTokens.toLocaleString()} tokens) per turn`);
console.log(`  Reduction in Request Payload: ${percentSavings}%`);
console.log(`  Tool Schema Savings: ${toolSavingsBytes.toLocaleString()} bytes (~${toolSavingsTokens.toLocaleString()} tokens) per turn (${toolPercentSavings}% reduction)`);
console.log("\n=== PROJECTED SAVINGS (over a 100-turn session) ===");
console.log(`  Total Tokens Saved: ~${(avgSavingsTokens * 100).toLocaleString()} tokens`);
console.log(`  Estimated Cost Saved (at $3.00/M input tokens): $${((avgSavingsTokens * 100) / 1000000 * 3.00).toFixed(4)}`);
