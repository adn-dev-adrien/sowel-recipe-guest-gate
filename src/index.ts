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
//      recipe only ever actuates an equipment of type `gate`, and only one the owner picked in the
//      plugin's page — so a flaw in the guest-facing half can at worst open a gate, never switch
//      anything else in the house.
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
// ONE instance serves the whole house (v0.4). A plugin cannot read another integration's devices,
// so this recipe hands it the catalogue of the house's gates — id, name, contact — and the owner
// picks from it in the plugin's page (« + portail »). Each request then names its gate, and this
// recipe pulses that one. The contact is for the owner's page only: the GUEST never sees it — a
// button reading « Fermer le portail » is a state display wearing a verb, and the guests' page is
// pollable by anyone holding a code.
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
    /** Fired on any edit, creation or removal of an equipment — its name among them. */
    onType(
      type: "equipment.updated" | "equipment.created" | "equipment.removed",
      handler: (event: { equipment?: { id: string; name?: string; type?: string }; equipmentId?: string }) => void,
    ): () => void;
  };
  equipmentManager: {
    getAll(): Array<{ id: string; name?: string; type?: string }>;
    getById(id: string): { id: string; name?: string; type?: string } | undefined | null;
    getByIdWithDetails(id: string): EquipmentDetails | undefined | null;
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
// The plugin's own aliases. Not slots: they belong to
// sowel-plugin-guest-access, which ships them, so exposing them as fields would
// only offer the user a way to get them wrong.
// ------------------------------------------------------------
const RESULT_ALIAS = "result";
/** The house's gates, as JSON, pushed down so the owner can pick from them. */
const CATALOG_ALIAS = "gate_catalog";
/** Which gate the request in flight is for — an equipment id. */
const TARGET_ALIAS = "last_request_gate";

const ACCESS_OPTIONS = [
  { value: "on", label: "Armed" },
  { value: "off", label: "Off" },
];

type GateState = "open" | "closed" | "unknown";

/** One gate of the house, as the plugin is told about it. */
export interface CatalogEntry {
  id: string;
  name: string;
  state: GateState;
}

/**
 * Reads the gate's belief from its bindings, by CATEGORY rather than by alias:
 * `gate_state` when the equipment has one (the virtual reading Sowel derives),
 * else the raw door contact. Deriving by category means no alias slot to fill in,
 * and it survives an installation whose aliases are named differently.
 */
export function readGateState(details: EquipmentDetails | undefined | null): GateState {
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

/** Every equipment of type `gate`, sorted by name — the only things this recipe will ever pulse. */
export function buildCatalog(ctx: Pick<RecipeContext, "equipmentManager">): CatalogEntry[] {
  return ctx.equipmentManager
    .getAll()
    .filter((e) => e.type === "gate")
    .map((e) => ({
      id: e.id,
      name: (e.name ?? e.id).trim(),
      state: readGateState(ctx.equipmentManager.getByIdWithDetails(e.id)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

const FR = {
  name: "Accès partagés — ouverture",
  description:
    "Ouvre le portail qu'une personne à qui vous avez donné un accès demande depuis son téléphone — un invité, un enfant, un artisan. Une seule pour toute la maison ; les portails se choisissent dans la page Accès partagés. Armable depuis le Dashboard.",
  slots: {
    zone: { name: "Zone", description: "La zone où ranger la tuile" },
    requestSource: {
      name: "Demandes d'ouverture",
      description:
        "L'équipement lié au device « Accès invités » du plugin Accès partagés. C'est lui qui compte les demandes.",
    },
    requestAlias: {
      name: "Alias du compteur",
      description: "L'alias de la donnée qui compte les demandes. « requests » sauf si vous l'avez renommé.",
    },
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
      name: "Accès partagés",
      options: { on: "Armé", off: "Arrêt" },
    },
  },
};

function buildSlots(): RecipeSlotDef[] {
  return [
    { id: "zone", name: "Zone", description: "The zone the tile lives in", type: "zone", required: true },
    {
      id: "requestSource",
      name: "Opening requests",
      description:
        "The equipment bound to the Shared access plugin's device (« Accès invités ») — the one counting the requests.",
      type: "equipment",
      required: true,
      // No type constraint on purpose: the device carries a counter and a few
      // readings and orders, and which equipment type a user binds that to is
      // their business.
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
      id: "commandAlias",
      name: "Command alias",
      description: "The order to send to a gate. `command` on a standard LoRa/Somfy installation.",
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
    name: "Shared Access — Opening",
    description:
      "Opens the gate someone you gave access to asks for from their phone — a guest, a child, a tradesperson. One for the whole house; gates are picked in the Shared access page. Armable from the Dashboard.",
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

      // A precise error beats a silent misconfiguration: without these the
      // recipe could neither tell the guest anything nor offer a gate to pick.
      const orders = (source.orderBindings ?? []).map((o) => o.alias);
      for (const alias of [RESULT_ALIAS, CATALOG_ALIAS]) {
        if (!orders.includes(alias)) {
          throw new Error(
            `The guest-access equipment carries no « ${alias} » order — bind the plugin's device orders to it`,
          );
        }
      }

      const requestAlias = textParam(params, "requestAlias", "requests");
      const data = (source.dataBindings ?? []).map((d) => d.alias);
      for (const alias of [requestAlias, TARGET_ALIAS]) {
        if (data.length && !data.includes(alias)) {
          throw new Error(
            `The guest-access equipment has no « ${alias} » reading (found: ${data.join(", ") || "none"})`,
          );
        }
      }
    },

    createInstance(params, ctx) {
      const sourceId = params.requestSource as string;
      const requestAlias = textParam(params, "requestAlias", "requests");
      const commandAlias = textParam(params, "commandAlias", "command");
      const commandValue = textParam(params, "commandValue", "pulse");

      let stopped = false;
      /** The counter as last seen. `null` until the first reading — see isNewRequest. */
      let lastCount: number | null = null;
      let openedCount = 0;
      let lastOpenedAt: string | null = null;
      let lastCatalog = "";
      let gateIds = new Set<string>();

      // Restored across a restart: a recipe update stops and recreates the
      // instance, and the switch must not silently re-arm itself.
      const restored = ctx.state.get("guestAccess");
      let access: "on" | "off" = restored === "off" ? "off" : "on";

      const summaryLine = (): string => {
        if (access === "off") return "Accès partagés coupés";
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

      /**
       * Hands the plugin the house's gates — names and contacts. Sent at start
       * and whenever one of them is created, renamed, removed or moves; never
       * twice the same, since a contact reading repeats itself all day.
       */
      const pushCatalog = async (): Promise<void> => {
        const catalog = buildCatalog(ctx);
        gateIds = new Set(catalog.map((g) => g.id));
        const text = JSON.stringify(catalog);
        if (text === lastCatalog) return;
        lastCatalog = text;
        try {
          await ctx.dispatchOrder(sourceId, CATALOG_ALIAS, text);
        } catch (err: unknown) {
          // Never fatal: the owner's page shows a stale list, and every press
          // still works on the gates it already knows.
          lastCatalog = "";
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`liste des portails non transmise au plugin — ${msg}`, "warn");
        }
      };

      const report = async (outcome: "opened" | "refused" | "error"): Promise<void> => {
        try {
          await ctx.dispatchOrder(sourceId, RESULT_ALIAS, outcome);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`issue « ${outcome} » non transmise au plugin — ${msg}`, "error");
        }
      };

      /** The gate the request is for, as the plugin wrote it just before the counter moved. */
      const readTarget = (): string => {
        const source = ctx.equipmentManager.getByIdWithDetails(sourceId);
        const binding = (source?.dataBindings ?? []).find((b) => b.alias === TARGET_ALIAS);
        return typeof binding?.value === "string" ? binding.value : "";
      };

      const onRequest = async (): Promise<void> => {
        if (stopped) return;

        if (access === "off") {
          ctx.log(`demande refusée : les accès partagés sont coupés`, "warn");
          await report("refused");
          publish();
          return;
        }

        // Only a gate. Whatever the plugin names, this recipe will not pulse an
        // equipment that is not one — the whole point of keeping the trigger here.
        const targetId = readTarget();
        const target = targetId ? ctx.equipmentManager.getById(targetId) : undefined;
        if (!target || target.type !== "gate") {
          ctx.log(`demande pour « ${targetId || "?"} », qui n'est pas un portail — rien n'est actionné`, "error");
          await report("error");
          publish();
          return;
        }
        const name = target.name ?? targetId;

        // The command always goes out — no look at the gate's state first. See the
        // header: a guest is allowed to close the gate behind them.
        let failure: string | null = null;
        try {
          const res = await ctx.dispatchOrder(targetId, commandAlias, commandValue);
          if (res && res.success === false) failure = res.error ?? "échec";
        } catch (err: unknown) {
          failure = err instanceof Error ? err.message : String(err);
        }

        if (failure) {
          ctx.log(`${name} : commande d'un accès partagé en échec — ${failure}`, "error");
          await report("error");
          publish();
          return;
        }

        openedCount += 1;
        lastOpenedAt = hhmm();
        ctx.log(`${name} : commande envoyée pour un accès partagé`);
        await report("opened");
        publish();
      };

      // --- wiring ---

      const unsubData = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (event.equipmentId === sourceId && event.alias === requestAlias) {
          const incoming = event.value;
          if (!isNewRequest(lastCount, incoming)) {
            // Also the path taken by the very first reading after a start: the
            // counter already has a value, and a restart must never open the gate.
            if (typeof incoming === "number" && Number.isFinite(incoming)) lastCount = incoming;
            return;
          }
          lastCount = incoming as number;
          void onRequest();
          return;
        }
        // A gate moved: its contact goes to the owner's page.
        if (gateIds.has(event.equipmentId)) void pushCatalog();
      });

      // A gate created, renamed or removed lands in the owner's list without
      // anyone thinking of it.
      const onEquipment = (): void => void pushCatalog();
      const unsubCreated = ctx.eventBus.onType("equipment.created", onEquipment);
      const unsubUpdated = ctx.eventBus.onType("equipment.updated", onEquipment);
      const unsubRemoved = ctx.eventBus.onType("equipment.removed", onEquipment);

      // Starting points: the counter as it stands (so nothing fires on a restart),
      // and the gates as they stand (so the owner's page is right from the first look).
      const sourceDetails = ctx.equipmentManager.getByIdWithDetails(sourceId);
      const initial = (sourceDetails?.dataBindings ?? []).find((b) => b.alias === requestAlias);
      if (initial && typeof initial.value === "number" && Number.isFinite(initial.value)) {
        lastCount = initial.value;
      }
      void pushCatalog();

      publish();
      ctx.log(
        `Recette démarrée : ${gateIds.size} portail${gateIds.size > 1 ? "s" : ""} proposé${gateIds.size > 1 ? "s" : ""} au plugin — accès partagés ` +
          `${access === "on" ? "armés" : "coupés"}, commande « ${commandAlias}=${commandValue} »`,
      );

      return {
        stop(): void {
          stopped = true;
          unsubData();
          unsubCreated();
          unsubUpdated();
          unsubRemoved();
        },

        onAction(action: string, payload?: Record<string, unknown>): void {
          if (action !== "set_guest_access") return;
          const asked = typeof payload?.value === "string" ? payload.value : null;
          access = asked === "on" || asked === "off" ? asked : access === "on" ? "off" : "on";
          publish();
          ctx.log(`accès partagés ${access === "on" ? "armés" : "coupés"}`);
        },
      };
    },
  };
}
