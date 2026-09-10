import { describe, expect, it } from "vitest";
import { createRecipe, readGateState, isNewRequest } from "./index.js";

// What these tests are really guarding: a recipe that holds the trigger of a gate
// must never fire it by accident — not on a restart, not on a repeated reading —
// and must always tell the guest what happened, including when it refuses.

type Handler = (event: { equipmentId: string; alias: string; value: unknown }) => void;

const SOURCE = "eq-guest-access";
const GATE = "eq-gate";

function makeCtx(over: Record<string, unknown> = {}) {
  const logs: Array<{ message: string; level: string }> = [];
  const state = new Map<string, unknown>(
    (over.state as Array<[string, unknown]> | undefined) ?? [],
  );
  const orders: Array<{ equipmentId: string; alias: string; value: unknown }> = [];
  const handlers: Handler[] = [];
  const unsubs: number[] = [];

  const sourceDetails = {
    id: SOURCE,
    name: "Accès invités",
    dataBindings: [{ alias: "requests", category: "generic", value: (over.initialCount as number) ?? 4 }],
    orderBindings: [
      { alias: "result", enumValues: ["opened", "already_open", "refused", "error"] },
      { alias: "gate_state", enumValues: ["open", "closed", "unknown"] },
    ],
  };
  const gateDetails = {
    id: GATE,
    name: "Portail",
    type: "gate",
    dataBindings: [
      { alias: "state", category: "gate_state", value: (over.gateState as string) ?? "closed" },
    ],
    orderBindings: [{ alias: "command", enumValues: ["pulse"] }],
  };

  const ctx = {
    log: (message: string, level = "info") => logs.push({ message, level }),
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => { state.set(key, value); },
    },
    eventBus: {
      onType: (_type: "equipment.data.changed", handler: Handler) => {
        handlers.push(handler);
        const index = handlers.length - 1;
        return () => unsubs.push(index);
      },
    },
    equipmentManager: {
      // Reads the SAME mutable objects as getByIdWithDetails: a fake where the two
      // disagree lets a test mutate the type and prove nothing.
      getById: (id: string) =>
        id === GATE
          ? { id: GATE, name: gateDetails.name, type: gateDetails.type }
          : id === SOURCE
            ? { id: SOURCE, name: sourceDetails.name }
            : undefined,
      getByIdWithDetails: (id: string) =>
        id === GATE ? gateDetails : id === SOURCE ? sourceDetails : undefined,
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

  return { ctx, logs, orders, state, handlers, unsubs, gateDetails, sourceDetails };
}

const PARAMS = { zone: "z1", requestSource: SOURCE, gate: GATE };

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

// ------------------------------------------------------------
// validate
// ------------------------------------------------------------

describe("validate", () => {
  const recipe = createRecipe();

  it("requires the zone, the source and the gate", () => {
    const { ctx } = makeCtx();
    expect(() => recipe.validate({}, ctx as never)).toThrow(/Zone/);
    expect(() => recipe.validate({ zone: "z1" }, ctx as never)).toThrow(/guest-access equipment is required/);
    expect(() => recipe.validate({ zone: "z1", requestSource: SOURCE }, ctx as never)).toThrow(/gate is required/);
  });

  it("refuses a source that cannot answer the guest", () => {
    const { ctx, sourceDetails } = makeCtx();
    sourceDetails.orderBindings = [{ alias: "gate_state", enumValues: [] }];
    expect(() => recipe.validate(PARAMS, ctx as never)).toThrow(/« result » order/);
    // Without it the recipe could open the gate and never tell the guest anything.
  });

  it("refuses a source whose counter is not there under the name given", () => {
    const { ctx } = makeCtx();
    expect(() => recipe.validate({ ...PARAMS, requestAlias: "compteur" }, ctx as never)).toThrow(/« compteur » reading/);
  });

  it("refuses an equipment that is not a gate, and a gate without the command", () => {
    const { ctx, gateDetails } = makeCtx();
    gateDetails.type = "light_onoff";
    expect(() => recipe.validate(PARAMS, ctx as never)).toThrow(/not a gate/);

    gateDetails.type = "gate";
    gateDetails.orderBindings = [{ alias: "autre", enumValues: [] }];
    expect(() => recipe.validate(PARAMS, ctx as never)).toThrow(/« command » order/);
  });

  it("accepts the standard installation", () => {
    const { ctx } = makeCtx();
    expect(() => recipe.validate(PARAMS, ctx as never)).not.toThrow();
  });
});

// ------------------------------------------------------------
// the instance
// ------------------------------------------------------------

describe("a guest presses", () => {
  it("sends the command and reports « opened »", async () => {
    const { ctx, orders, handlers, state } = makeCtx({ initialCount: 4 });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 5 });
    await settle();

    const gateOrder = orders.find((o) => o.equipmentId === GATE);
    expect(gateOrder).toEqual({ equipmentId: GATE, alias: "command", value: "pulse" });
    expect(orders.some((o) => o.alias === "result" && o.value === "opened")).toBe(true);
    expect(state.get("openedCount")).toBe(1);
    expect(String(state.get("summary"))).toMatch(/Armé — 1 ouverture/);
    instance.stop();
  });

  it("does NOT look at whether the gate is open first — a guest may close it behind them", async () => {
    const { ctx, orders, handlers } = makeCtx({ initialCount: 4, gateState: "open" });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 5 });
    await settle();

    expect(orders.some((o) => o.equipmentId === GATE && o.value === "pulse")).toBe(true);
    expect(orders.some((o) => o.alias === "result" && o.value === "opened")).toBe(true);
    instance.stop();
  });

  it("a restart never opens the gate", async () => {
    const { ctx, orders, handlers } = makeCtx({ initialCount: 9 });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    // The counter is republished as it stands when the instance comes up.
    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 9 });
    await settle();

    expect(orders.some((o) => o.equipmentId === GATE)).toBe(false);
    instance.stop();
  });

  it("an instance that starts with no reading at all still does not fire on the first one", async () => {
    const { ctx, orders, handlers, sourceDetails } = makeCtx();
    sourceDetails.dataBindings = [{ alias: "requests", category: "generic", value: undefined }];
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 3 });
    await settle();
    expect(orders.some((o) => o.equipmentId === GATE)).toBe(false);

    // ...and the one after it does.
    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 4 });
    await settle();
    expect(orders.some((o) => o.equipmentId === GATE)).toBe(true);
    instance.stop();
  });

  it("ignores a repeated reading, a lower one, and another equipment's", async () => {
    const { ctx, orders, handlers } = makeCtx({ initialCount: 4 });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 4 });
    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 3 });
    handlers[0]({ equipmentId: SOURCE, alias: "autre", value: 99 });
    handlers[0]({ equipmentId: "eq-autre", alias: "requests", value: 99 });
    await settle();

    expect(orders.some((o) => o.equipmentId === GATE)).toBe(false);
    instance.stop();
  });

  it("counts each request once, and keeps counting", async () => {
    const { ctx, orders, handlers, state } = makeCtx({ initialCount: 0 });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    for (const value of [1, 2, 3]) {
      handlers[0]({ equipmentId: SOURCE, alias: "requests", value });
      await settle();
    }

    expect(orders.filter((o) => o.equipmentId === GATE)).toHaveLength(3);
    expect(state.get("openedCount")).toBe(3);
    instance.stop();
  });
});

describe("when the access is cut", () => {
  it("reports « refused » and never touches the gate", async () => {
    const { ctx, orders, handlers, logs, state } = makeCtx({ initialCount: 4 });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);
    instance.onAction!("set_guest_access", { value: "off" });

    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 5 });
    await settle();

    expect(orders.some((o) => o.equipmentId === GATE)).toBe(false);
    expect(orders.some((o) => o.alias === "result" && o.value === "refused")).toBe(true);
    // A cut access must not fail silently: the guest's phone says so.
    expect(logs.some((l) => l.level === "warn" && /coupé/.test(l.message))).toBe(true);
    expect(state.get("summary")).toBe("Accès invités coupé");
    instance.stop();
  });

  it("the switch survives a restart", async () => {
    const { ctx, orders, handlers } = makeCtx({ initialCount: 4, state: [["guestAccess", "off"]] });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 5 });
    await settle();

    expect(orders.some((o) => o.equipmentId === GATE)).toBe(false);
    instance.stop();
  });

  it("the tile toggles it both ways", () => {
    const { ctx, state } = makeCtx();
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    expect(state.get("guestAccess")).toBe("on");
    instance.onAction!("set_guest_access", {});
    expect(state.get("guestAccess")).toBe("off");
    instance.onAction!("set_guest_access", {});
    expect(state.get("guestAccess")).toBe("on");
    instance.onAction!("unknown_action", {});
    expect(state.get("guestAccess")).toBe("on");
    instance.stop();
  });
});

describe("when the gate refuses the command", () => {
  it("reports « error » rather than letting the guest believe it opened", async () => {
    const { ctx, orders, handlers, logs } = makeCtx({ initialCount: 4, failOrder: { alias: "command", error: "nœud muet" } });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 5 });
    await settle();

    expect(orders.some((o) => o.alias === "result" && o.value === "error")).toBe(true);
    expect(logs.some((l) => l.level === "error" && /nœud muet/.test(l.message))).toBe(true);
    instance.stop();
  });

  it("a thrown dispatch is handled the same way", async () => {
    const { ctx, orders, handlers } = makeCtx({ initialCount: 4, failOrder: { alias: "command", error: "throw" } });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);

    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 5 });
    await settle();

    expect(orders.some((o) => o.alias === "result" && o.value === "error")).toBe(true);
    instance.stop();
  });
});

describe("the gate state pushed back to GuestFlow", () => {
  it("is sent at start, so the first guest gets the right button", async () => {
    const { ctx, orders } = makeCtx({ gateState: "closed" });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);
    await settle();

    expect(orders).toEqual([{ equipmentId: SOURCE, alias: "gate_state", value: "closed" }]);
    instance.stop();
  });

  it("follows the contact, and only on a change", async () => {
    const { ctx, orders, handlers, gateDetails } = makeCtx({ gateState: "closed" });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);
    await settle();
    const before = orders.filter((o) => o.alias === "gate_state").length;

    gateDetails.dataBindings = [{ alias: "state", category: "gate_state", value: "open" }];
    handlers[1]({ equipmentId: GATE, alias: "state", value: "open" });
    await settle();
    handlers[1]({ equipmentId: GATE, alias: "state", value: "open" });
    await settle();

    const pushes = orders.filter((o) => o.alias === "gate_state");
    expect(pushes).toHaveLength(before + 1);
    expect(pushes[pushes.length - 1].value).toBe("open");
    instance.stop();
  });

  it("a failure to push it is a warning, never fatal", async () => {
    const { ctx, logs, handlers, orders } = makeCtx({ initialCount: 4, failOrder: { alias: "gate_state", error: "throw" } });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);
    await settle();

    expect(logs.some((l) => l.level === "warn")).toBe(true);
    // And the gate still opens: a mislabelled button is cosmetic.
    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 5 });
    await settle();
    expect(orders.some((o) => o.equipmentId === GATE)).toBe(true);
    instance.stop();
  });
});

describe("stop", () => {
  it("unsubscribes both watches and stops acting", async () => {
    const { ctx, orders, handlers, unsubs } = makeCtx({ initialCount: 4 });
    const instance = createRecipe().createInstance(PARAMS, ctx as never);
    instance.stop();

    expect(unsubs).toHaveLength(2);
    handlers[0]({ equipmentId: SOURCE, alias: "requests", value: 5 });
    await settle();
    expect(orders.some((o) => o.equipmentId === GATE)).toBe(false);
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
