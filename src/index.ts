// ============================================================
// Guest Gate Access — external Sowel recipe
//
// A guest of the gîte or the lodge presses a button on their phone, and this gate opens. Who they
// are, when their stay runs and whether their code is still good is decided by
// `sowel-plugin-guest-access`, in this house; what arrives here is a bare request, and this recipe
// is what turns it into an impulse.
//
// It exists rather than the plugin pulsing the gate itself for two reasons worth more than the code
// it holds:
//
//   1. **Nothing that decides also actuates.** The plugin serves an anonymous page on the internet
//      (Sowel core spec 180) and holds the accesses; it publishes a counter and nothing else. The
//      equipment that opens is chosen here, by an admin, in a recipe instance — so a flaw in the
//      guest-facing half cannot become a gate command on its own.
//   2. **You keep a switch.** The Dashboard tile arms and disarms guest access in one click, without
//      opening the accesses page and without waiting for anything. A disarmed access does not fail
//      silently: the guest's phone says the command was refused from the house.
//
// What it deliberately does NOT do:
//
//   • it does not look at whether the gate is open before pulsing. That guard existed in the first
//     draft, to stop a second guest closing the gate on the first one's car — and it took away
//     something guests legitimately do, which is to close the gate behind them. Adrien's call,
//     2026-09-10: the command always goes out, exactly like the remote this replaces, with the same
//     property that a second press during the travel reverses it.
//   • it does not deduplicate. The plugin already absorbs the double press (a 2 s window) and it is
//     the only place that can tell one slipped thumb from two intentions.
//   • it does not hold a deadline of its own. Nothing here re-closes the gate;
//     `portal-night-closure` is what does that, and two automations each holding their own deadline
//     on an impulse gate send two impulses for one opening.
//
// The gate contact travels the other way, and that is not decoration: a plugin cannot read another
// integration's device, so this recipe reads it and pushes it down. The GUEST never sees it — a
// button reading « Fermer le portail » is a state display wearing a verb, and the guests' page is
// pollable by anyone holding a code. The owner sees it, on the « Accès invités » page.
// ============================================================

// ------------------------------------------------------------
// Types mirrored from Sowel core (src/shared/types.ts). Recipe packages never
// import the core; these are kept in sync by hand.
// ------------------------------------------------------------

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key" | "select";
  required: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  constraints?: {
    equipmentType?: string | string[];
    crossZone?: boolean;
    min?: number;
    max?: number;
  };
}

interface RecipeActionDef {
  id: string;
  type: "cycle";
  stateKey: string;
  options: { value: string; label: string }[];
}

interface RecipeTileDef {
  icon?: string;
  summaryKey?: string;
  countdownKey?: string;
  actions?: string[];
  confirm?: boolean;
}

interface DataBinding {
  alias: string;
  key?: string;
  category?: string;
  value?: unknown;
}

interface OrderBinding {
  alias: string;
  key?: string;
  category?: string;
  enumValues?: string[];
}

interface EquipmentDetails {
  id: string;
  name?: string;
  type?: string;
  dataBindings?: DataBinding[];
  orderBindings?: OrderBinding[];
}

interface RecipeContext {
  log(message: string, level?: "info" | "warn" | "error"): void;
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  eventBus: {
    onType(
      type: "equipment.data.changed",
      handler: (event: { equipmentId: string; alias: string; value: unknown }) => void,
    ): () => void;
  };
  equipmentManager: {
    getById(id: string): { id: string; name?: string; type?: string } | undefined;
    getByIdWithDetails(id: string): EquipmentDetails | undefined;
  };
  dispatchOrder(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success?: boolean; error?: string } | void>;
}

interface RecipeInstanceHandle {
  stop(): void;
  onAction?(action: string, payload?: Record<string, unknown>): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: RecipeActionDef[];
  tile?: RecipeTileDef;
  i18n?: Record<string, unknown>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle;
}

// ------------------------------------------------------------
// The plugin's own order aliases. Not slots: they belong to
// sowel-plugin-guest-access, which ships them, so exposing them as fields would
// only offer the user a way to get them wrong.
// ------------------------------------------------------------
const RESULT_ALIAS = "result";
const GATE_STATE_ALIAS = "gate_state";

const ACCESS_OPTIONS = [
  { value: "on", label: "Armed" },
  { value: "off", label: "Off" },
];

type GateState = "open" | "closed" | "unknown";

/**
 * Reads the gate's belief from its bindings, by CATEGORY rather than by alias:
 * `gate_state` when the equipment has one (the virtual reading Sowel derives),
 * else the raw door contact. Deriving by category means no alias slot to fill in,
 * and it survives an installation whose aliases are named differently.
 */
export function readGateState(details: EquipmentDetails | undefined): GateState {
  const bindings = details?.dataBindings ?? [];

  const derived = bindings.find((b) => b.category === "gate_state");
  if (derived && typeof derived.value === "string") {
    if (derived.value === "closed") return "closed";
    if (derived.value === "open") return "open";
  }

  const contact = bindings.find((b) => b.category === "contact_door");
  if (contact && typeof contact.value === "boolean") {
    // `closed: true` is the certainty; `false` only says the contact is not made.
    return contact.value ? "closed" : "open";
  }

  return "unknown";
}

/** A request counter only ever counts up. Anything else is not a new request. */
export function isNewRequest(previous: number | null, incoming: unknown): boolean {
  if (typeof incoming !== "number" || !Number.isFinite(incoming)) return false;
  if (previous === null) return false; // the first reading is the starting point, never an opening
  return incoming > previous;
}

const FR = {
  name: "Accès invités au portail",
  description:
    "Ouvre le portail quand un client du gîte ou de la lodge le demande depuis son téléphone — armable depuis le Dashboard, et toujours elle qui décide.",
  slots: {
    zone: { name: "Zone", description: "La zone où vit le portail" },
    requestSource: {
      name: "Demandes des invités",
      description:
        "L'équipement lié au device « Accès invités » du plugin guest-access. C'est lui qui compte les demandes des clients.",
    },
    requestAlias: {
      name: "Alias du compteur",
      description: "L'alias de la donnée qui compte les demandes. « requests » sauf si vous l'avez renommé.",
    },
    gate: { name: "Portail", description: "Le portail à ouvrir" },
    commandAlias: {
      name: "Alias de la commande",
      description: "L'ordre à envoyer au portail. « command » sur une installation LoRa/Somfy standard.",
    },
    commandValue: {
      name: "Valeur de la commande",
      description: "La valeur de cet ordre. « pulse » pour une impulsion.",
    },
  },
  actions: {
    set_guest_access: {
      name: "Accès invités",
      options: { on: "Armé", off: "Arrêt" },
    },
  },
};

function buildSlots(): RecipeSlotDef[] {
  return [
    { id: "zone", name: "Zone", description: "The zone the gate lives in", type: "zone", required: true },
    {
      id: "requestSource",
      name: "Guest requests",
      description:
        "The equipment bound to the guest-access plugin's device — the one counting the guests' requests.",
      type: "equipment",
      required: true,
      // No type constraint on purpose: the device carries a counter and two enum
      // orders, and which equipment type a user binds that to is their business.
      constraints: { crossZone: true },
    },
    {
      id: "requestAlias",
      name: "Counter alias",
      description: "Alias of the data counting the requests. `requests` unless you renamed it.",
      type: "text",
      required: false,
      defaultValue: "requests",
    },
    {
      id: "gate",
      name: "Gate",
      description: "The gate to open",
      type: "equipment",
      required: true,
      constraints: { equipmentType: "gate", crossZone: true },
    },
    {
      id: "commandAlias",
      name: "Command alias",
      description: "The order to send to the gate. `command` on a standard LoRa/Somfy installation.",
      type: "text",
      required: false,
      defaultValue: "command",
    },
    {
      id: "commandValue",
      name: "Command value",
      description: "The value of that order. `pulse` for an impulse.",
      type: "text",
      required: false,
      defaultValue: "pulse",
    },
  ];
}

function textParam(params: Record<string, unknown>, id: string, fallback: string): string {
  const raw = params[id];
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

export function createRecipe(): RecipeDefinition {
  return {
    id: "guest-gate",
    name: "Guest Gate Access",
    description:
      "Opens the gate when a guest of the gîte or the lodge asks for it from their phone — armable from the Dashboard, and always the one that decides.",
    slots: buildSlots(),

    actions: [
      {
        id: "set_guest_access",
        type: "cycle",
        stateKey: "guestAccess",
        options: ACCESS_OPTIONS,
      },
    ],

    // Two options on a cycle action make the whole card a toggle: one click arms
    // or disarms. No `confirm` here — arming moves nothing, and nothing leaves
    // for the gate until a guest presses their own button. Asking for a
    // slide-to-confirm to flip a permission would be friction for its own sake.
    tile: {
      icon: "DoorOpen",
      actions: ["set_guest_access"],
    },

    i18n: { fr: FR },

    validate(params, ctx) {
      if (!params.zone) throw new Error("Zone is required");

      const sourceId = typeof params.requestSource === "string" ? params.requestSource : "";
      if (!sourceId) throw new Error("The guest-access equipment is required");
      const source = ctx.equipmentManager.getByIdWithDetails(sourceId);
      if (!source) throw new Error("Guest-access equipment not found");

      // A precise error beats a silent misconfiguration: without these two orders
      // the recipe could open the gate but never tell the guest anything.
      const orders = (source.orderBindings ?? []).map((o) => o.alias);
      for (const alias of [RESULT_ALIAS, GATE_STATE_ALIAS]) {
        if (!orders.includes(alias)) {
          throw new Error(
            `The guest-access equipment carries no « ${alias} » order — bind the plugin's device orders to it`,
          );
        }
      }

      const requestAlias = textParam(params, "requestAlias", "requests");
      const data = (source.dataBindings ?? []).map((d) => d.alias);
      if (data.length && !data.includes(requestAlias)) {
        throw new Error(
          `The guest-access equipment has no « ${requestAlias} » reading (found: ${data.join(", ") || "none"})`,
        );
      }

      const gateId = typeof params.gate === "string" ? params.gate : "";
      if (!gateId) throw new Error("A gate is required");
      const gate = ctx.equipmentManager.getById(gateId);
      if (!gate) throw new Error("Gate not found");
      if (gate.type !== undefined && gate.type !== "gate") {
        throw new Error(`Selected equipment is not a gate (type: ${gate.type})`);
      }

      const gateDetails = ctx.equipmentManager.getByIdWithDetails(gateId);
      const commandAlias = textParam(params, "commandAlias", "command");
      const gateOrders = (gateDetails?.orderBindings ?? []).map((o) => o.alias);
      if (gateOrders.length && !gateOrders.includes(commandAlias)) {
        throw new Error(
          `The gate carries no « ${commandAlias} » order (found: ${gateOrders.join(", ") || "none"})`,
        );
      }
    },

    createInstance(params, ctx) {
      const sourceId = params.requestSource as string;
      const gateId = params.gate as string;
      const requestAlias = textParam(params, "requestAlias", "requests");
      const commandAlias = textParam(params, "commandAlias", "command");
      const commandValue = textParam(params, "commandValue", "pulse");

      let stopped = false;
      /** The counter as last seen. `null` until the first reading — see isNewRequest. */
      let lastCount: number | null = null;
      let openedCount = 0;
      let lastOpenedAt: string | null = null;
      let lastGateState: GateState | null = null;

      // Restored across a restart: a recipe update stops and recreates the
      // instance, and the switch must not silently re-arm itself.
      const restored = ctx.state.get("guestAccess");
      let access: "on" | "off" = restored === "off" ? "off" : "on";

      const gateName = (): string => ctx.equipmentManager.getById(gateId)?.name ?? "portail";

      const summaryLine = (): string => {
        if (access === "off") return "Accès invités coupé";
        if (!openedCount) return "Armé — aucune demande";
        const plural = openedCount > 1 ? "s" : "";
        return `Armé — ${openedCount} ouverture${plural}${lastOpenedAt ? ` · dernière à ${lastOpenedAt}` : ""}`;
      };

      const publish = (): void => {
        ctx.state.set("guestAccess", access);
        ctx.state.set("openedCount", openedCount);
        ctx.state.set("summary", summaryLine());
      };

      const hhmm = (): string =>
        new Intl.DateTimeFormat("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Paris",
        }).format(new Date());

      /** Tells the plugin what the contact says, for the owner's page. */
      const pushGateState = async (state: GateState): Promise<void> => {
        if (state === lastGateState) return;
        lastGateState = state;
        try {
          await ctx.dispatchOrder(sourceId, GATE_STATE_ALIAS, state);
        } catch (err: unknown) {
          // Never fatal: an owner's page showing a stale contact is a cosmetic
          // problem, and the pulse still works.
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`état du portail non transmis au plugin — ${msg}`, "warn");
        }
      };

      const report = async (outcome: "opened" | "refused" | "error", detail?: string): Promise<void> => {
        try {
          await ctx.dispatchOrder(sourceId, RESULT_ALIAS, outcome);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`issue « ${outcome} » non transmise au plugin — ${msg}`, "error");
          return;
        }
        if (detail) ctx.log(detail);
      };

      const onRequest = async (): Promise<void> => {
        if (stopped) return;

        if (access === "off") {
          ctx.log(`demande d'un client refusée : l'accès invités est coupé`, "warn");
          await report("refused", undefined);
          publish();
          return;
        }

        // The command always goes out — no look at the gate's state first. See the
        // header: a guest is allowed to close the gate behind them.
        let failure: string | null = null;
        try {
          const res = await ctx.dispatchOrder(gateId, commandAlias, commandValue);
          if (res && res.success === false) failure = res.error ?? "échec";
        } catch (err: unknown) {
          failure = err instanceof Error ? err.message : String(err);
        }

        if (failure) {
          ctx.log(`${gateName()} : commande d'un client en échec — ${failure}`, "error");
          await report("error");
          publish();
          return;
        }

        openedCount += 1;
        lastOpenedAt = hhmm();
        ctx.log(`${gateName()} : commande envoyée pour un client`);
        await report("opened");
        publish();
      };

      // --- wiring ---

      const unsubRequests = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (event.equipmentId !== sourceId) return;
        if (event.alias !== requestAlias) return;
        const incoming = event.value;
        if (!isNewRequest(lastCount, incoming)) {
          // Also the path taken by the very first reading after a start: the
          // counter already has a value, and a restart must never open the gate.
          if (typeof incoming === "number" && Number.isFinite(incoming)) lastCount = incoming;
          return;
        }
        lastCount = incoming as number;
        void onRequest();
      });

      const unsubGate = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (event.equipmentId !== gateId) return;
        void pushGateState(readGateState(ctx.equipmentManager.getByIdWithDetails(gateId)));
      });

      // Starting points: the counter as it stands (so nothing fires on a restart),
      // and the contact as it stands (so the owner's page is right from the
      // first look, not only after the gate next moves).
      const sourceDetails = ctx.equipmentManager.getByIdWithDetails(sourceId);
      const initial = (sourceDetails?.dataBindings ?? []).find((b) => b.alias === requestAlias);
      if (initial && typeof initial.value === "number" && Number.isFinite(initial.value)) {
        lastCount = initial.value;
      }
      void pushGateState(readGateState(ctx.equipmentManager.getByIdWithDetails(gateId)));

      publish();
      ctx.log(
        `Recette démarrée : ${gateName()} ouvert sur demande des clients — accès invités ` +
          `${access === "on" ? "armé" : "coupé"}, commande « ${commandAlias}=${commandValue} »`,
      );

      return {
        stop(): void {
          stopped = true;
          unsubRequests();
          unsubGate();
        },

        onAction(action: string, payload?: Record<string, unknown>): void {
          if (action !== "set_guest_access") return;
          const asked = typeof payload?.value === "string" ? payload.value : null;
          access = asked === "on" || asked === "off" ? asked : access === "on" ? "off" : "on";
          publish();
          ctx.log(`accès invités ${access === "on" ? "armé" : "coupé"}`);
        },
      };
    },
  };
}
