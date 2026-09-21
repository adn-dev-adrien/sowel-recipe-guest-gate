import { describe, expect, it } from "vitest";
import { createRecipe, readGateState, isNewRequest, buildCatalog } from "./index.js";

// What these tests are really guarding: a recipe that holds the trigger of the
// house's gates must never fire one by accident — not on a restart, not on a
// repeated reading, never on something that is not a gate — and must always tell
// the guest what happened, including when it refuses.

type Handler = (event: Record<string, unknown>) => void;

const SOURCE = "eq-guest-access";
const GATE = "eq-gate";
const GARAGE = "eq-garage";
const LAMP = "eq-lamp";

interface Eq {
  id: string;
  name: string;
  type: string;
  dataBindings: Array<{ alias: string; category?: string; value?: unknown }>;
  orderBindings: Array<{ alias: string; enumValues?: string[] }>;
}

function makeCtx(over: Record<string, unknown> = {}) {
  const logs: Array<{ message: string; level: string }> = [];
  const state = new Map<string, unknown>((over.state as Array<[string, unknown]> | undefined) ?? []);
  const orders: Array<{ equipmentId: string; alias: string; value: unknown }> = [];
  const handlers: Array<{ type: string; handler: Handler }> = [];
  const unsubs: number[] = [];

  const source: Eq = {
    id: SOURCE,
    name: "Accès partagés",
    type: "switch",
    dataBindings: [
      { alias: "requests", category: "generic", value: (over.initialCount as number) ?? 4 },
      { alias: "last_request_gate", category: "generic", value: (over.target as string) ?? GATE },
    ],
    orderBindings: [
      { alias: "result", enumValues: ["opened", "already_open", "refused", "error"] },
      { alias: "gate_catalog" },
    ],
  };
  const gate: Eq = {
    id: GATE,
    name: "Portail d'entrée",
    type: "gate",
    dataBindings: [{ alias: "state", category: "gate_state", value: (over.gateState as string) ?? "closed" }],
    orderBindings: [{ alias: "command", enumValues: ["pulse"] }],
  };
  const garage: Eq = {
    id: GARAGE,
    name: "Garage",
    type: "gate",
    dataBindings: [{ alias: "closed", category: "contact_door", value: false }],
    orderBindings: [{ alias: "command" }],
  };
  const lamp: Eq = { id: LAMP, name: "Lampe", type: "light_onoff", dataBindings: [], orderBindings: [{ alias: "command" }] };
  const all: Eq[] = [source, gate, garage, lamp];

  const ctx = {
    log: (message: string, level = "info") => logs.push({ message, level }),
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => { state.set(key, value); },
    },
    eventBus: {
      onType: (type: string, handler: Handler) => {
        handlers.push({ type, handler });
        const index = handlers.length - 1;
        return () => unsubs.push(index);
      },
    },
    equipmentManager: {
      // One set of mutable objects behind every accessor: a fake where they
      // disagree lets a test change a name and prove nothing.
      getAll: () => all.map((e) => ({ id: e.id, name: e.name, type: e.type })),
      getById: (id: string) => {
        const e = all.find((x) => x.id === id);
        return e ? { id: e.id, name: e.name, type: e.type } : undefined;
      },
      getByIdWithDetails: (id: string) => all.find((x) => x.id === id),
    },
    dispatchOrder: async (equipmentId: string, alias: string, value: unknown) => {
      orders.push({ equipmentId, alias, value });
      const fail = over.failOrder as { alias: string; error?: string } | undefined;
      if (fail && fail.alias === alias) {
        if (fail.error === "throw") throw new Error("bus indisponible");
        return { success: false, error: fail.error ?? "refusé" };
      }
      return { success: true };
    },
  };

  const fire = (type: string, event: Record<string, unknown>) => {
    handlers.forEach((h, i) => { if (h.type === type && !unsubs.includes(i)) h.handler(event); });
  };
  /** The plugin, pressing: it names the gate first, then moves the counter. */
  const press = (count: number, target = GATE) => {
    source.dataBindings[1].value = target;
    fire("equipment.data.changed", { equipmentId: SOURCE, alias: "requests", value: count });
  };
  const catalogs = () => orders.filter((o) => o.alias === "gate_catalog").map((o) => JSON.parse(o.value as string));
  return { ctx, logs, orders, state, fire, press, catalogs, unsubs, handlers, source, gate, garage, all };
}

const PARAMS = { zone: "z1", requestSource: SOURCE };

/** Lets the fire-and-forget promises inside the handlers settle. */
const settle = () => new Promise((done) => setTimeout(done, 0));

// ------------------------------------------------------------
// the pure parts
// ------------------------------------------------------------

describe("isNewRequest", () => {
  it("the first reading is a starting point, never an opening", () => {
    // This is the line that keeps a restart from opening the gate.
    expect(isNewRequest(null, 7)).toBe(false);
  });

  it("only a strictly higher count is a new request", () => {
    expect(isNewRequest(4, 5)).toBe(true);
    expect(isNewRequest(4, 4)).toBe(false);
    expect(isNewRequest(4, 3)).toBe(false);
  });

  it("anything that is not a finite number is not a request", () => {
    expect(isNewRequest(4, "5")).toBe(false);
    expect(isNewRequest(4, null)).toBe(false);
    expect(isNewRequest(4, undefined)).toBe(false);
    expect(isNewRequest(4, NaN)).toBe(false);
    // Infinity included: a counter that has gone infinite is a bug upstream, and
    // pulsing a gate on a bug is not a behaviour worth having.
    expect(isNewRequest(4, Infinity)).toBe(false);
  });
});

describe("readGateState", () => {
  it("prefers the derived gate_state reading", () => {
    expect(readGateState({ id: GATE, dataBindings: [{ alias: "state", category: "gate_state", value: "open" }] })).toBe("open");
    expect(readGateState({ id: GATE, dataBindings: [{ alias: "state", category: "gate_state", value: "closed" }] })).toBe("closed");
  });

  it("falls back to the door contact, where `closed: true` is the certainty", () => {
    expect(readGateState({ id: GATE, dataBindings: [{ alias: "closed", category: "contact_door", value: true }] })).toBe("closed");
    expect(readGateState({ id: GATE, dataBindings: [{ alias: "closed", category: "contact_door", value: false }] })).toBe("open");
  });

  it("says unknown rather than guessing", () => {
    expect(readGateState(undefined)).toBe("unknown");
    expect(readGateState({ id: GATE, dataBindings: [] })).toBe("unknown");
    expect(readGateState({ id: GATE, dataBindings: [{ alias: "rssi", category: "generic", value: -107 }] })).toBe("unknown");
  });
});

describe("buildCatalog", () => {
  it("lists every gate of the house, by name, with its contact — and nothing else", () => {
    const { ctx } = makeCtx();
    expect(buildCatalog(ctx)).toEqual([
      { id: GARAGE, name: "Garage", state: "open" },
      { id: GATE, name: "Portail d'entrée", state: "closed" },
    ]);
  });
});

// ------------------------------------------------------------
// validate
// ------------------------------------------------------------

describe("validate", () => {
  const recipe = createRecipe();

  it("requires the zone and the source — and no gate: those are picked in the plugin", () => {
    const { ctx } = makeCtx();
    expect(() => recipe.validate({ requestSource: SOURCE }, ctx)).toThrow(/Zone/);
    expect(() => recipe.validate({ zone: "z1" }, ctx)).toThrow(/guest-access equipment is required/);
    expect(() => recipe.validate(PARAMS, ctx)).not.toThrow();
    expect(recipe.slots.map((s) => s.id)).not.toContain("gate");
  });

  it("refuses a source that cannot answer the guest or receive the gates", () => {
    for (const alias of ["result", "gate_catalog"]) {
      const { ctx, source } = makeCtx();
      source.orderBindings = source.orderBindings.filter((o) => o.alias !== alias);
      expect(() => recipe.validate(PARAMS, ctx)).toThrow(new RegExp(alias));
    }
  });

  it("refuses a source without the counter or the gate it names", () => {
    const { ctx, source } = makeCtx();
    source.dataBindings = source.dataBindings.filter((d) => d.alias !== "last_request_gate");
    expect(() => recipe.validate(PARAMS, ctx)).toThrow(/last_request_gate/);
    const other = makeCtx();
    expect(() => recipe.validate({ ...PARAMS, requestAlias: "hits" }, other.ctx)).toThrow(/hits/);
  });
});

// ------------------------------------------------------------
// the instance
// ------------------------------------------------------------

describe("a request", () => {
  it("pulses the gate the plugin named, and reports « opened »", async () => {
    const h = makeCtx();
    createRecipe().createInstance(PARAMS, h.ctx);
    h.press(5, GARAGE);
    await settle();
    expect(h.orders.filter((o) => o.alias !== "gate_catalog")).toEqual([
      { equipmentId: GARAGE, alias: "command", value: "pulse" },
      { equipmentId: SOURCE, alias: "result", value: "opened" },
    ]);
  });

  it("will not pulse anything that is not a gate, whatever the plugin names", async () => {
    for (const target of [LAMP, "nowhere", ""]) {
      const h = makeCtx();
      createRecipe().createInstance(PARAMS, h.ctx);
      h.press(5, target);
      await settle();
      expect(h.orders.some((o) => o.alias === "command")).toBe(false);
      expect(h.orders.at(-1)).toEqual({ equipmentId: SOURCE, alias: "result", value: "error" });
    }
  });

  it("does NOT look at whether the gate is open first — a guest may close it behind them", async () => {
    const h = makeCtx({ gateState: "open" });
    createRecipe().createInstance(PARAMS, h.ctx);
    h.press(5);
    await settle();
    expect(h.orders).toContainEqual({ equipmentId: GATE, alias: "command", value: "pulse" });
  });

  it("a restart never opens a gate", async () => {
    const h = makeCtx({ initialCount: 9 });
    createRecipe().createInstance(PARAMS, h.ctx);
    h.press(9);
    await settle();
    expect(h.orders.some((o) => o.alias === "command")).toBe(false);
  });

  it("an instance that starts with no reading at all still does not fire on the first one", async () => {
    const h = makeCtx();
    h.source.dataBindings[0].value = undefined;
    createRecipe().createInstance(PARAMS, h.ctx);
    h.press(3);
    await settle();
    expect(h.orders.some((o) => o.alias === "command")).toBe(false);
    h.press(4);
    await settle();
    expect(h.orders.filter((o) => o.alias === "command")).toHaveLength(1);
  });

  it("ignores a repeated reading, a lower one, and another equipment's", async () => {
    const h = makeCtx();
    createRecipe().createInstance(PARAMS, h.ctx);
    h.press(4);
    h.press(3);
    h.fire("equipment.data.changed", { equipmentId: "elsewhere", alias: "requests", value: 99 });
    await settle();
    expect(h.orders.some((o) => o.alias === "command")).toBe(false);
  });

  it("uses the command the instance was configured with", async () => {
    const h = makeCtx();
    createRecipe().createInstance({ ...PARAMS, commandAlias: "trigger", commandValue: "on" }, h.ctx);
    h.press(5);
    await settle();
    expect(h.orders).toContainEqual({ equipmentId: GATE, alias: "trigger", value: "on" });
  });
});

describe("when the access is cut", () => {
  it("reports « refused » and never touches a gate", async () => {
    const h = makeCtx({ state: [["guestAccess", "off"]] });
    createRecipe().createInstance(PARAMS, h.ctx);
    h.press(5);
    await settle();
    expect(h.orders.some((o) => o.alias === "command")).toBe(false);
    expect(h.orders.at(-1)).toEqual({ equipmentId: SOURCE, alias: "result", value: "refused" });
  });

  it("the tile toggles it both ways, and the switch survives a restart", () => {
    const h = makeCtx();
    const instance = createRecipe().createInstance(PARAMS, h.ctx);
    instance.onAction?.("set_guest_access");
    expect(h.state.get("guestAccess")).toBe("off");
    instance.onAction?.("set_guest_access", { value: "on" });
    expect(h.state.get("guestAccess")).toBe("on");
    instance.onAction?.("set_guest_access", { value: "off" });
    const again = makeCtx({ state: [["guestAccess", "off"]] });
    createRecipe().createInstance(PARAMS, again.ctx);
    expect(again.state.get("summary")).toBe("Accès partagés coupés");
  });
});

describe("when the gate refuses the command", () => {
  it("reports « error » rather than letting the guest believe it opened", async () => {
    const h = makeCtx({ failOrder: { alias: "command" } });
    createRecipe().createInstance(PARAMS, h.ctx);
    h.press(5);
    await settle();
    expect(h.orders.at(-1)).toEqual({ equipmentId: SOURCE, alias: "result", value: "error" });
  });

  it("a thrown dispatch is handled the same way", async () => {
    const h = makeCtx({ failOrder: { alias: "command", error: "throw" } });
    createRecipe().createInstance(PARAMS, h.ctx);
    h.press(5);
    await settle();
    expect(h.orders.at(-1)).toEqual({ equipmentId: SOURCE, alias: "result", value: "error" });
  });
});

describe("the gates handed to the plugin", () => {
  it("are sent at start, so the owner can pick from them at once", async () => {
    const h = makeCtx();
    createRecipe().createInstance(PARAMS, h.ctx);
    await settle();
    expect(h.catalogs()).toEqual([
      [
        { id: GARAGE, name: "Garage", state: "open" },
        { id: GATE, name: "Portail d'entrée", state: "closed" },
      ],
    ]);
  });

  it("follow a contact, a rename, a new gate — and are never sent twice the same", async () => {
    const h = makeCtx();
    createRecipe().createInstance(PARAMS, h.ctx);
    await settle();
    // A reading that repeats itself changes nothing.
    h.fire("equipment.data.changed", { equipmentId: GATE, alias: "state", value: "closed" });
    await settle();
    expect(h.catalogs()).toHaveLength(1);

    h.gate.dataBindings[0].value = "open";
    h.fire("equipment.data.changed", { equipmentId: GATE, alias: "state", value: "open" });
    await settle();
    expect(h.catalogs().at(-1)).toContainEqual({ id: GATE, name: "Portail d'entrée", state: "open" });

    h.gate.name = "Grand portail";
    h.fire("equipment.updated", { equipment: { id: GATE, name: "Grand portail" } });
    await settle();
    expect(h.catalogs().at(-1).map((g: { name: string }) => g.name)).toContain("Grand portail");

    h.all.push({ id: "eq-new", name: "Portillon", type: "gate", dataBindings: [], orderBindings: [] });
    h.fire("equipment.created", { equipment: { id: "eq-new", type: "gate" } });
    await settle();
    expect(h.catalogs().at(-1)).toHaveLength(3);
  });

  it("a failure to send them is a warning, never fatal", async () => {
    const h = makeCtx({ failOrder: { alias: "gate_catalog", error: "throw" } });
    createRecipe().createInstance(PARAMS, h.ctx);
    await settle();
    expect(h.logs.some((l) => l.level === "warn" && /portails/.test(l.message))).toBe(true);
    h.press(5);
    await settle();
    expect(h.orders).toContainEqual({ equipmentId: GATE, alias: "command", value: "pulse" });
  });
});

describe("stop", () => {
  it("unsubscribes every watch and stops acting", async () => {
    const h = makeCtx();
    const instance = createRecipe().createInstance(PARAMS, h.ctx);
    instance.stop();
    expect(h.unsubs).toHaveLength(h.handlers.length);
    h.press(5);
    await settle();
    expect(h.orders.some((o) => o.alias === "command")).toBe(false);
  });
});

describe("the package contract", () => {
  it("declares the tile and its single action, with no confirmation", () => {
    const recipe = createRecipe();
    expect(recipe.tile?.actions).toEqual(["set_guest_access"]);
    // Arming moves nothing — nothing leaves for the gate until a guest presses
    // their own button. A slide-to-confirm here would be friction for its own sake.
    expect(recipe.tile?.confirm).toBeUndefined();
    expect(recipe.actions?.[0].stateKey).toBe("guestAccess");
  });

  it("ships French for every slot and the action", () => {
    const recipe = createRecipe();
    const fr = recipe.i18n?.fr as { slots: Record<string, unknown>; actions: Record<string, unknown> };
    for (const slot of recipe.slots) {
      expect(fr.slots[slot.id], `slot ${slot.id} has no French`).toBeDefined();
    }
    expect(fr.actions.set_guest_access).toBeDefined();
  });
});
