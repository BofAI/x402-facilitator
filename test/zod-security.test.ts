import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z, PaymentPayloadV2Schema, ResourceInfoSchema } from "@x402/core/schemas";

describe("patched collection validation", () => {
  for (const bound of ["max", "length"] as const) {
    for (const asyncParse of [false, true]) {
      it(`rejects oversized ${bound} arrays before visiting elements (async=${asyncParse})`, async () => {
        let visits = 0;
        const schema = z.array(z.string().superRefine(() => { visits += 1; }))[bound](2);
        const oversized = Array.from({ length: 1_000 }, () => "valid");
        const rejected = asyncParse
          ? await schema.safeParseAsync(oversized)
          : schema.safeParse(oversized);
        expect(rejected.success).toBe(false);
        expect(visits).toBe(0);

        const accepted = asyncParse
          ? await schema.safeParseAsync(["one", "two"])
          : schema.safeParse(["one", "two"]);
        expect(accepted.success).toBe(true);
        expect(visits).toBe(2);
      });
    }
  }

  it("bounds issue allocation in official Core resource tags", () => {
    const result = ResourceInfoSchema.safeParse({ url: "https://example.test", tags: Array(1_000).fill(0) });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("oversized resource tags accepted");
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]).toMatchObject({ code: "too_big", path: ["tags"] });
  });

  it("preserves SDK 2.0 payment records and strips unknown envelope fields", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/sdk2-schemes.json", import.meta.url), "utf8"));
    const payload = fixture.payloads.upto;
    const result = PaymentPayloadV2Schema.parse({ ...payload, unknownEnvelopeField: "strip" });
    expect(result.payload).toEqual(payload.payload);
    expect(result.accepted).toEqual(payload.accepted);
    expect(result).not.toHaveProperty("unknownEnvelopeField");
  });
});
