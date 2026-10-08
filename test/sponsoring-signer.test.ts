import { describe, expect, it } from "vitest";
import { assertResourcePermission } from "../src/sponsoring/signer.js";
const address = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const operations = Buffer.alloc(32); operations[7] = 6;
const permission = { id: 2, type: 2, threshold: 1, operations: operations.toString("hex"), keys: [{ address, weight: 1 }] };
describe("Resource Owner active permission", () => {
  it("allows only the dedicated active key with exactly Delegate and UnDelegate", () => {
    expect(() => assertResourcePermission({ active_permission: [permission] }, 2, address)).not.toThrow();
    const broad = Buffer.from(operations); broad[0] = 1;
    for (const entry of [{ ...permission, operations: broad.toString("hex") }, { ...permission, threshold: 2 },
      { ...permission, keys: [] }, { ...permission, id: 3 }]) {
      expect(() => assertResourcePermission({ active_permission: [entry] }, 2, address)).toThrow();
    }
  });
});
