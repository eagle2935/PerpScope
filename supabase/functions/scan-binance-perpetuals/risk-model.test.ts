import { riskSetup } from "./risk-model.ts";

Deno.test("LONG setup produces exact 3R geometry", () => {
  const x = riskSetup("LONG", 100, 1);
  if (!x || x.stop !== 98.5 || x.target !== 104.5 || x.rr !== 3) throw new Error(JSON.stringify(x));
});

Deno.test("SHORT setup produces exact 3R geometry", () => {
  const x = riskSetup("SHORT", 100, 1);
  if (!x || x.stop !== 101.5 || x.target !== 95.5 || x.rr !== 3) throw new Error(JSON.stringify(x));
});

Deno.test("Rejects missing, zero and non-finite ATR", () => {
  if (riskSetup("LONG", 100, null) !== null) throw new Error("null ATR accepted");
  if (riskSetup("LONG", 100, 0) !== null) throw new Error("zero ATR accepted");
  if (riskSetup("LONG", 100, Number.NaN) !== null) throw new Error("NaN ATR accepted");
});

Deno.test("Rejects stops outside 0.25%-3% risk band", () => {
  if (riskSetup("LONG", 100, 0.01) !== null) throw new Error("too-tight stop accepted");
  if (riskSetup("LONG", 100, 3) !== null) throw new Error("too-wide stop accepted");
});

Deno.test("Rejects invalid price", () => {
  if (riskSetup("LONG", 0, 1) !== null) throw new Error("zero price accepted");
});
