/**
 * FamilyCart Lambda Handler
 *
 * Domain: Shopping Plans → Shopping Items → Purchase History
 *
 * Tables:
 *   FamilyCartPlans    – one record per shopping occasion
 *   FamilyCartItems    – items belonging to a plan
 *   FamilyCartHistory  – permanent purchase records (survive item deletion)
 *   FamilyCartActivity – family timeline events
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { randomUUID } from "crypto";

// ─── Environment ──────────────────────────────────────────────────────────────

const REGION        = process.env.AWS_REGION      || "us-east-1";
const ITEMS_TABLE   = process.env.ITEMS_TABLE     || "FamilyCartItems";
const PLANS_TABLE   = process.env.PLANS_TABLE     || "FamilyCartPlans";
const HISTORY_TABLE = process.env.HISTORY_TABLE   || "FamilyCartHistory";
const ACTIVITY_TABLE= process.env.ACTIVITY_TABLE  || "FamilyCartActivity";
const MODEL_ID      = process.env.BEDROCK_MODEL_ID|| "us.amazon.nova-2-lite-v1:0";

// ─── Clients ──────────────────────────────────────────────────────────────────

const bedrock = new BedrockRuntimeClient({ region: REGION });
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ─── Domain types ─────────────────────────────────────────────────────────────

type PlanStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED";
type ItemStatus = "NEEDED" | "LOW" | "PARTIALLY_BOUGHT" | "BOUGHT";
type Priority   = "LOW" | "MEDIUM" | "HIGH";

interface ShoppingPlan {
  id: string;
  familyId: string;
  shoppingDate: string;   // ISO date string YYYY-MM-DD
  assignedTo: string;
  status: PlanStatus;
  title?: string;
  createdAt: string;
  completedAt?: string;
}

interface ShoppingItem {
  id: string;
  familyId: string;
  shoppingPlanId: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  status: ItemStatus;
  priority: Priority;
  addedBy: string;
  createdAt: string;
  boughtQuantity?: number | null;
  boughtUnit?: string | null;
  boughtBy?: string;
  boughtAt?: string;
}

interface PurchaseHistory {
  id: string;
  familyId: string;
  shoppingPlanId: string;
  itemId: string;        // original item id (may be deleted)
  itemName: string;
  quantity: number | null;
  unit: string | null;
  purchasedBy: string;
  purchasedAt: string;
}

// ─── HTTP response helper ─────────────────────────────────────────────────────

function resp(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseBody(raw: string | null): Record<string, unknown> {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

async function recordActivity(
  familyId: string,
  userName: string,
  action: string,
  itemName: string,
  quantity?: number | null,
  unit?: string | null,
) {
  await dynamo.send(new PutCommand({
    TableName: ACTIVITY_TABLE,
    Item: {
      id: randomUUID(),
      familyId,
      userName,
      action,
      itemName,
      quantity:  quantity  ?? null,
      unit:      unit      ?? null,
      timestamp: new Date().toISOString(),
    },
  }));
}

/** Fetch a plan and validate family ownership. Returns null if not found/wrong family. */
async function getValidatedPlan(planId: string, familyId: string): Promise<ShoppingPlan | null> {
  const r = await dynamo.send(new GetCommand({ TableName: PLANS_TABLE, Key: { id: planId } }));
  if (!r.Item || r.Item.familyId !== familyId) return null;
  return r.Item as ShoppingPlan;
}

/** Fetch an item and validate family ownership. Returns null if not found/wrong family. */
async function getValidatedItem(itemId: string, familyId: string): Promise<ShoppingItem | null> {
  const r = await dynamo.send(new GetCommand({ TableName: ITEMS_TABLE, Key: { id: itemId } }));
  if (!r.Item || r.Item.familyId !== familyId) return null;
  return r.Item as ShoppingItem;
}

/** Get most-recent active plan for a family. */
async function getActivePlan(familyId: string): Promise<ShoppingPlan | null> {
  const r = await dynamo.send(new QueryCommand({
    TableName: PLANS_TABLE,
    IndexName: "byFamily",
    KeyConditionExpression: "familyId = :fid",
    FilterExpression: "#st <> :completed",
    ExpressionAttributeNames: { "#st": "status" },
    ExpressionAttributeValues: { ":fid": familyId, ":completed": "COMPLETED" },
    ScanIndexForward: false,   // newest first by shoppingDate
    Limit: 1,
  }));
  return (r.Items?.[0] as ShoppingPlan) ?? null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event: any) => {
  const method: string = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path: string   = event.rawPath || event.path || "/";
  const qs             = event.queryStringParameters || {};
  const pathParams     = event.pathParameters || {};

  console.log("FamilyCart", { method, path });

  if (method === "OPTIONS") return resp(200, {});

  try {

    // ========================================================
    // GET /shopping-plans
    // ========================================================
    if (method === "GET" && path.endsWith("/shopping-plans")) {
      const familyId = qs.familyId || "demo-family";

      const r = await dynamo.send(new QueryCommand({
        TableName: PLANS_TABLE,
        IndexName: "byFamily",
        KeyConditionExpression: "familyId = :fid",
        ExpressionAttributeValues: { ":fid": familyId },
        ScanIndexForward: false,
      }));

      return resp(200, { plans: r.Items ?? [] });
    }

    // ========================================================
    // POST /shopping-plans
    // ========================================================
    if (method === "POST" && path.endsWith("/shopping-plans")) {
      const body       = parseBody(event.body);
      const familyId   = (body.familyId as string)   || "demo-family";
      const assignedTo = (body.assignedTo as string)  || "Family Member";
      const shoppingDate = (body.shoppingDate as string) || new Date().toISOString().slice(0, 10);
      const title      = (body.title as string) || `Shopping – ${shoppingDate}`;

      const plan: ShoppingPlan = {
        id: randomUUID(),
        familyId,
        shoppingDate,
        assignedTo,
        title,
        status: "PLANNED",
        createdAt: new Date().toISOString(),
      };

      await dynamo.send(new PutCommand({ TableName: PLANS_TABLE, Item: plan }));
      return resp(201, { plan });
    }

    // ========================================================
    // GET /shopping-plans/{id}
    // ========================================================
    if (method === "GET" && path.match(/\/shopping-plans\/[^/]+$/)) {
      const familyId = qs.familyId || "demo-family";
      const planId   = pathParams.id || path.split("/").at(-1)!;

      const plan = await getValidatedPlan(planId, familyId);
      if (!plan) return resp(404, { error: "Shopping plan not found" });

      // Fetch items for this plan
      const itemsResult = await dynamo.send(new QueryCommand({
        TableName: ITEMS_TABLE,
        IndexName: "byPlan",
        KeyConditionExpression: "shoppingPlanId = :pid",
        ExpressionAttributeValues: { ":pid": planId },
      }));

      return resp(200, { plan, items: itemsResult.Items ?? [] });
    }

    // ========================================================
    // PATCH /shopping-plans/{id}
    // ========================================================
    if (method === "PATCH" && path.match(/\/shopping-plans\/[^/]+$/)) {
      const body     = parseBody(event.body);
      const familyId = (body.familyId as string) || "demo-family";
      const planId   = pathParams.id || path.split("/").at(-1)!;

      const plan = await getValidatedPlan(planId, familyId);
      if (!plan) return resp(404, { error: "Shopping plan not found" });

      const updateParts: string[] = [];
      const names: Record<string, string>  = {};
      const values: Record<string, unknown> = {};

      if (body.status) {
        updateParts.push("#st = :st");
        names["#st"] = "status";
        values[":st"] = body.status;
        if (body.status === "COMPLETED") {
          updateParts.push("completedAt = :ca");
          values[":ca"] = new Date().toISOString();
        }
      }
      if (body.assignedTo) { updateParts.push("assignedTo = :at"); values[":at"] = body.assignedTo; }
      if (body.shoppingDate) { updateParts.push("shoppingDate = :sd"); values[":sd"] = body.shoppingDate; }
      if (body.title) { updateParts.push("#ti = :ti"); names["#ti"] = "title"; values[":ti"] = body.title; }

      if (updateParts.length === 0) return resp(400, { error: "No updatable fields provided" });

      const r = await dynamo.send(new UpdateCommand({
        TableName: PLANS_TABLE,
        Key: { id: planId },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }));

      return resp(200, { plan: r.Attributes });
    }

    // ========================================================
    // GET /items
    // ========================================================
    if (method === "GET" && path.endsWith("/items")) {
      const familyId    = qs.familyId    || "demo-family";
      const shoppingPlanId = qs.shoppingPlanId;

      if (shoppingPlanId) {
        // Query by plan via GSI
        const r = await dynamo.send(new QueryCommand({
          TableName: ITEMS_TABLE,
          IndexName: "byPlan",
          KeyConditionExpression: "shoppingPlanId = :pid",
          FilterExpression: "familyId = :fid",
          ExpressionAttributeValues: { ":pid": shoppingPlanId, ":fid": familyId },
        }));
        return resp(200, { items: r.Items ?? [] });
      }

      // Fallback: scan by family (for legacy support / active-plan queries)
      const r = await dynamo.send(new ScanCommand({
        TableName: ITEMS_TABLE,
        FilterExpression: "familyId = :fid",
        ExpressionAttributeValues: { ":fid": familyId },
      }));
      return resp(200, { items: r.Items ?? [] });
    }

    // ========================================================
    // POST /items   (manual single-item add)
    // ========================================================
    if (method === "POST" && path.endsWith("/items")) {
      const body           = parseBody(event.body);
      const familyId       = (body.familyId as string)  || "demo-family";
      const addedBy        = (body.addedBy as string)   || "Family Member";
      const name           = body.name as string;
      const shoppingPlanId = body.shoppingPlanId as string | undefined;

      if (!name) return resp(400, { error: "name is required" });

      // Resolve plan
      let resolvedPlanId = shoppingPlanId;
      if (!resolvedPlanId) {
        const active = await getActivePlan(familyId);
        resolvedPlanId = active?.id;
      }
      if (!resolvedPlanId) return resp(400, { error: "No active shopping plan. Create a plan first." });

      // Duplicate check within the same plan
      const existing = await dynamo.send(new QueryCommand({
        TableName: ITEMS_TABLE,
        IndexName: "byPlan",
        KeyConditionExpression: "shoppingPlanId = :pid",
        FilterExpression: "familyId = :fid",
        ExpressionAttributeValues: { ":pid": resolvedPlanId, ":fid": familyId },
      }));
      const activeItems = (existing.Items || []).filter(
        (i: any) => i.status !== "BOUGHT"
      );
      const duplicate = activeItems.find(
        (i: any) => normalizeName(i.name) === normalizeName(name)
      );
      if (duplicate) {
        return resp(409, {
          error: "duplicate",
          message: `${name} is already on this week's shopping list.`,
          existingItem: duplicate,
        });
      }

      const item: ShoppingItem = {
        id: randomUUID(),
        familyId,
        shoppingPlanId: resolvedPlanId,
        name,
        quantity:  (body.quantity as number | null) ?? null,
        unit:      (body.unit as string | null)     ?? null,
        status:    (body.status as ItemStatus)      || "NEEDED",
        priority:  (body.priority as Priority)      || "MEDIUM",
        addedBy,
        createdAt: new Date().toISOString(),
      };

      await dynamo.send(new PutCommand({ TableName: ITEMS_TABLE, Item: item }));
      await recordActivity(familyId, addedBy, "added", name, item.quantity, item.unit);
      return resp(201, { item });
    }

    // ========================================================
    // PATCH /items/{id}   (edit item — name/quantity/unit/status/priority)
    // ========================================================
    if (method === "PATCH" && path.match(/\/items\/[^/]+$/) && !path.endsWith("/bought")) {
      const body     = parseBody(event.body);
      const familyId = (body.familyId as string) || "demo-family";
      const itemId   = pathParams.id || path.split("/").at(-1)!;
      const editedBy = (body.editedBy as string) || "Family Member";

      const item = await getValidatedItem(itemId, familyId);
      if (!item) return resp(404, { error: "Item not found" });

      const updateParts: string[] = [];
      const names: Record<string, string>  = {};
      const values: Record<string, unknown> = {};

      if (body.name !== undefined)     { updateParts.push("#nm = :nm"); names["#nm"] = "name"; values[":nm"] = body.name; }
      if (body.quantity !== undefined) { updateParts.push("quantity = :q"); values[":q"] = body.quantity; }
      if (body.unit !== undefined)     { updateParts.push("#u = :u"); names["#u"] = "unit"; values[":u"] = body.unit; }
      if (body.status !== undefined)   { updateParts.push("#st = :st"); names["#st"] = "status"; values[":st"] = body.status; }
      if (body.priority !== undefined) { updateParts.push("priority = :pr"); values[":pr"] = body.priority; }

      if (updateParts.length === 0) return resp(400, { error: "No updatable fields provided" });

      const r = await dynamo.send(new UpdateCommand({
        TableName: ITEMS_TABLE,
        Key: { id: itemId },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_NEW",
      }));

      if (body.quantity !== undefined || body.name !== undefined) {
        const updatedName = (body.name as string) || item.name;
        const updatedQty  = body.quantity !== undefined ? (body.quantity as number) : item.quantity;
        const updatedUnit = body.unit     !== undefined ? (body.unit as string)     : item.unit;
        await recordActivity(familyId, editedBy, "edited", updatedName, updatedQty, updatedUnit);
      }

      return resp(200, { item: r.Attributes });
    }

    // ========================================================
    // DELETE /items/{id}
    // ========================================================
    if (method === "DELETE" && path.match(/\/items\/[^/]+$/)) {
      const body      = parseBody(event.body);
      const familyId  = (body.familyId as string)  || "demo-family";
      const removedBy = (body.removedBy as string) || "Family Member";
      const itemId    = pathParams.id || path.split("/").at(-1)!;

      const item = await getValidatedItem(itemId, familyId);
      if (!item) return resp(404, { error: "Item not found" });

      await dynamo.send(new DeleteCommand({ TableName: ITEMS_TABLE, Key: { id: itemId } }));
      await recordActivity(familyId, removedBy, "removed", item.name, item.quantity, item.unit);

      return resp(200, { message: "Item removed", id: itemId, name: item.name });
    }

    // ========================================================
    // POST /items/{id}/purchase   (record actual purchase with quantity)
    // ========================================================
    if (method === "POST" && path.match(/\/items\/[^/]+\/purchase$/)) {
      const body         = parseBody(event.body);
      const familyId     = (body.familyId as string)     || "demo-family";
      const purchasedBy  = (body.purchasedBy as string)  || "Family Member";
      const boughtQty    = body.boughtQuantity as number | null | undefined;
      const boughtUnit   = (body.boughtUnit as string)   || null;
      const itemId       = pathParams.id || path.split("/").at(-3)!;

      const item = await getValidatedItem(itemId, familyId);
      if (!item) return resp(404, { error: "Item not found" });

      const neededQty    = item.quantity;
      const actualQty    = boughtQty !== undefined ? boughtQty : neededQty;
      const now          = new Date().toISOString();

      // Determine new status
      let newStatus: ItemStatus = "BOUGHT";
      if (neededQty !== null && actualQty !== null && actualQty < neededQty) {
        newStatus = "PARTIALLY_BOUGHT";
      }

      // Update item
      const r = await dynamo.send(new UpdateCommand({
        TableName: ITEMS_TABLE,
        Key: { id: itemId },
        UpdateExpression:
          "SET #st = :st, boughtQuantity = :bq, boughtUnit = :bu, boughtBy = :bb, boughtAt = :ba",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":st": newStatus,
          ":bq": actualQty,
          ":bu": boughtUnit || item.unit,
          ":bb": purchasedBy,
          ":ba": now,
        },
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_NEW",
      }));

      // Write permanent purchase history record
      const historyEntry: PurchaseHistory = {
        id: randomUUID(),
        familyId,
        shoppingPlanId: item.shoppingPlanId,
        itemId,
        itemName: item.name,
        quantity: actualQty,
        unit: boughtUnit || item.unit,
        purchasedBy,
        purchasedAt: now,
      };
      await dynamo.send(new PutCommand({ TableName: HISTORY_TABLE, Item: historyEntry }));

      // Activity
      await recordActivity(familyId, purchasedBy, "bought", item.name, actualQty, boughtUnit || item.unit);

      return resp(200, {
        message: newStatus === "BOUGHT" ? "Item purchased" : "Item partially purchased",
        item: r.Attributes,
        historyEntry,
        status: newStatus,
      });
    }

    // ========================================================
    // PATCH /items/{id}/bought  (legacy route — full purchase)
    // ========================================================
    if (method === "PATCH" && path.includes("/items/") && path.endsWith("/bought")) {
      const body        = parseBody(event.body);
      const familyId    = (body.familyId as string)  || "demo-family";
      const boughtBy    = (body.boughtBy as string)  || "Family Member";
      const itemId      = pathParams.id || path.split("/").at(-2)!;
      const now         = new Date().toISOString();

      const item = await getValidatedItem(itemId, familyId);
      if (!item) return resp(404, { error: "Item not found" });

      const r = await dynamo.send(new UpdateCommand({
        TableName: ITEMS_TABLE,
        Key: { id: itemId },
        UpdateExpression:
          "SET #st = :st, boughtQuantity = :bq, boughtUnit = :bu, boughtBy = :bb, boughtAt = :ba",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":st": "BOUGHT" as ItemStatus,
          ":bq": item.quantity,
          ":bu": item.unit,
          ":bb": boughtBy,
          ":ba": now,
        },
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_NEW",
      }));

      // Write history
      await dynamo.send(new PutCommand({
        TableName: HISTORY_TABLE,
        Item: {
          id: randomUUID(),
          familyId,
          shoppingPlanId: item.shoppingPlanId,
          itemId,
          itemName: item.name,
          quantity: item.quantity,
          unit: item.unit,
          purchasedBy: boughtBy,
          purchasedAt: now,
        },
      }));

      await recordActivity(familyId, boughtBy, "bought", item.name, item.quantity, item.unit);

      return resp(200, { message: "Item marked as bought", item: r.Attributes });
    }

    // ========================================================
    // POST /ai/parse
    // ========================================================
    if (method === "POST" && path.endsWith("/ai/parse")) {
      const body           = parseBody(event.body);
      const text           = body.text as string;
      const familyId       = (body.familyId as string)       || "demo-family";
      const addedBy        = (body.addedBy as string)        || "Family Member";
      const shoppingPlanId = body.shoppingPlanId as string | undefined;
      const forceAdd       = body.forceAdd === true;

      if (!text) return resp(400, { error: "text is required" });

      // Resolve plan
      let resolvedPlanId = shoppingPlanId;
      if (!resolvedPlanId) {
        const active = await getActivePlan(familyId);
        resolvedPlanId = active?.id;
      }
      if (!resolvedPlanId) {
        return resp(400, {
          error: "No active shopping plan. Create a plan first.",
          code: "NO_ACTIVE_PLAN",
        });
      }

      // Call Bedrock — extract items WITH quantities
      const prompt = `You are FamilyCart, an AI assistant for a shared household shopping list.

Extract every shopping item from the user message. Return ONLY valid JSON, no markdown.

User message: "${text}"

Return this exact JSON shape:
{
  "items": [
    {
      "name": "item name (singular, title case, e.g. Rice, Cooking Oil, Dish Soap)",
      "quantity": 5,
      "unit": "kg",
      "status": "NEEDED or LOW",
      "priority": "LOW, MEDIUM, or HIGH"
    }
  ]
}

Rules for quantity and unit:
- If the user specifies a number and unit, extract both exactly.
- "5 kilos of rice" → quantity: 5, unit: "kg"
- "2 packs of detergent" → quantity: 2, unit: "packs"
- "4 litres of milk" → quantity: 4, unit: "L"
- "1 basket of vegetables" → quantity: 1, unit: "basket"
- If no quantity is mentioned, set quantity to null and unit to null.
- Never invent quantities. If unsure, use null.

Rules for status:
- "almost out", "running low", "nearly finished", "low on" → LOW
- "need", "buy", "get", "out of", "finished" → NEEDED

Rules for priority:
- Essential food/hygiene items → HIGH
- Regular groceries → MEDIUM
- Optional items → LOW

Return only the JSON object. No explanation. No markdown.`;

      const bedrockResult = await bedrock.send(new ConverseCommand({
        modelId: MODEL_ID,
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 600, temperature: 0.1 },
      }));

      const rawOutput = bedrockResult.output?.message?.content?.[0]?.text || "";
      console.log("Bedrock output:", rawOutput);

      let parsed: { items: Array<{ name: string; quantity: number | null; unit: string | null; status: string; priority: string }> };
      try {
        parsed = JSON.parse(rawOutput);
      } catch {
        const match = rawOutput.match(/\{[\s\S]*\}/);
        if (!match) return resp(500, { error: "Could not parse AI response", raw: rawOutput });
        parsed = JSON.parse(match[0]);
      }

      // Fetch existing active items for duplicate check
      const existingResult = await dynamo.send(new QueryCommand({
        TableName: ITEMS_TABLE,
        IndexName: "byPlan",
        KeyConditionExpression: "shoppingPlanId = :pid",
        FilterExpression: "familyId = :fid",
        ExpressionAttributeValues: { ":pid": resolvedPlanId, ":fid": familyId },
      }));
      const activeItems = (existingResult.Items || []).filter((i: any) => i.status !== "BOUGHT");
      const activeNames = new Set(activeItems.map((i: any) => normalizeName(i.name)));

      const newItems: ShoppingItem[]    = [];
      const duplicates: Array<{ name: string; existingItem: unknown }> = [];

      for (const parsed_item of (parsed.items || [])) {
        const nameNorm = normalizeName(parsed_item.name);
        if (!forceAdd && activeNames.has(nameNorm)) {
          const existing = activeItems.find((i: any) => normalizeName(i.name) === nameNorm);
          duplicates.push({ name: parsed_item.name, existingItem: existing });
        } else {
          newItems.push({
            id: randomUUID(),
            familyId,
            shoppingPlanId: resolvedPlanId,
            name: parsed_item.name,
            quantity: parsed_item.quantity ?? null,
            unit: parsed_item.unit ?? null,
            status: (parsed_item.status as ItemStatus) || "NEEDED",
            priority: (parsed_item.priority as Priority) || "MEDIUM",
            addedBy,
            createdAt: new Date().toISOString(),
          });
        }
      }

      // Persist new items
      for (const item of newItems) {
        await dynamo.send(new PutCommand({ TableName: ITEMS_TABLE, Item: item }));
        await recordActivity(familyId, addedBy, "added", item.name, item.quantity, item.unit);
      }

      return resp(200, {
        message: newItems.length > 0
          ? `${newItems.length} item(s) added`
          : "No new items added",
        items: newItems,
        duplicates,
        shoppingPlanId: resolvedPlanId,
      });
    }

    // ========================================================
    // GET /history
    // ========================================================
    if (method === "GET" && path.endsWith("/history")) {
      const familyId = qs.familyId || "demo-family";
      const itemName = qs.itemName as string | undefined;
      const limitStr = qs.limit as string | undefined;
      const limit    = limitStr ? parseInt(limitStr, 10) : 50;

      const r = await dynamo.send(new QueryCommand({
        TableName: HISTORY_TABLE,
        IndexName: "byFamily",
        KeyConditionExpression: "familyId = :fid",
        ExpressionAttributeValues: { ":fid": familyId },
        ScanIndexForward: false,
        Limit: limit,
      }));

      let history = (r.Items || []) as PurchaseHistory[];
      if (itemName) {
        const nameNorm = normalizeName(itemName);
        history = history.filter(h => normalizeName(h.itemName) === nameNorm);
      }

      return resp(200, { history });
    }

    // ========================================================
    // GET /suggestions
    // ========================================================
    if (method === "GET" && path.endsWith("/suggestions")) {
      const familyId = qs.familyId || "demo-family";

      // Get purchase history
      const historyResult = await dynamo.send(new QueryCommand({
        TableName: HISTORY_TABLE,
        IndexName: "byFamily",
        KeyConditionExpression: "familyId = :fid",
        ExpressionAttributeValues: { ":fid": familyId },
        ScanIndexForward: false,
        Limit: 200,
      }));

      const allHistory = (historyResult.Items || []) as PurchaseHistory[];

      // Group by normalized item name
      const byName = new Map<string, PurchaseHistory[]>();
      for (const h of allHistory) {
        const key = normalizeName(h.itemName);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key)!.push(h);
      }

      // Get current active items so we don't suggest something already on the list
      const activePlan = await getActivePlan(familyId);
      const activeNamesSet = new Set<string>();
      if (activePlan) {
        const activeResult = await dynamo.send(new QueryCommand({
          TableName: ITEMS_TABLE,
          IndexName: "byPlan",
          KeyConditionExpression: "shoppingPlanId = :pid",
          FilterExpression: "familyId = :fid AND #st <> :bought",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":pid": activePlan.id, ":fid": familyId, ":bought": "BOUGHT",
          },
        }));
        (activeResult.Items || []).forEach((i: any) => activeNamesSet.add(normalizeName(i.name)));
      }

      const now  = Date.now();
      const suggestions: Array<{
        name: string;
        typicalQuantity: number | null;
        typicalUnit: string | null;
        purchaseCount: number;
        lastPurchasedAt: string;
        daysSinceLastPurchase: number;
        avgDaysBetweenPurchases: number | null;
        reason: string;
        alreadyOnList: boolean;
      }> = [];

      for (const [nameKey, records] of byName.entries()) {
        if (records.length === 0) continue;

        const displayName   = records[0].itemName;
        const alreadyOnList = activeNamesSet.has(nameKey);

        // Most common quantity
        const qtyCounts = new Map<number, number>();
        for (const r of records) {
          if (r.quantity !== null && r.quantity !== undefined) {
            qtyCounts.set(r.quantity, (qtyCounts.get(r.quantity) || 0) + 1);
          }
        }
        let typicalQty: number | null = null;
        let maxCount = 0;
        for (const [q, c] of qtyCounts.entries()) {
          if (c > maxCount) { typicalQty = q; maxCount = c; }
        }

        // Most common unit
        const unitCounts = new Map<string, number>();
        for (const r of records) {
          if (r.unit) unitCounts.set(r.unit, (unitCounts.get(r.unit) || 0) + 1);
        }
        let typicalUnit: string | null = null;
        let maxUnitCount = 0;
        for (const [u, c] of unitCounts.entries()) {
          if (c > maxUnitCount) { typicalUnit = u; maxUnitCount = c; }
        }

        // Sort by date desc
        const sorted = records.slice().sort(
          (a, b) => new Date(b.purchasedAt).getTime() - new Date(a.purchasedAt).getTime()
        );
        const lastPurchasedAt        = sorted[0].purchasedAt;
        const daysSinceLast          = Math.round((now - new Date(lastPurchasedAt).getTime()) / 86_400_000);

        // Average interval
        let avgDays: number | null = null;
        if (sorted.length >= 2) {
          const intervals: number[] = [];
          for (let i = 0; i < sorted.length - 1; i++) {
            const diff = new Date(sorted[i].purchasedAt).getTime() - new Date(sorted[i + 1].purchasedAt).getTime();
            intervals.push(Math.round(diff / 86_400_000));
          }
          avgDays = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
        }

        // Build reason
        let reason: string;
        if (records.length === 1) {
          reason = `Purchased before${typicalQty ? ` (${typicalQty}${typicalUnit ? " " + typicalUnit : ""})` : ""}`;
        } else if (avgDays !== null) {
          reason = `Usually every ${avgDays} day${avgDays === 1 ? "" : "s"} · last ${daysSinceLast} day${daysSinceLast === 1 ? "" : "s"} ago`;
        } else {
          reason = `Purchased ${records.length} times`;
        }

        suggestions.push({
          name: displayName,
          typicalQuantity: typicalQty,
          typicalUnit,
          purchaseCount: records.length,
          lastPurchasedAt,
          daysSinceLastPurchase: daysSinceLast,
          avgDaysBetweenPurchases: avgDays,
          reason,
          alreadyOnList,
        });
      }

      // Sort by most likely needed (days since > avg interval)
      suggestions.sort((a, b) => {
        const scoreA = a.avgDaysBetweenPurchases ? a.daysSinceLastPurchase / a.avgDaysBetweenPurchases : a.purchaseCount;
        const scoreB = b.avgDaysBetweenPurchases ? b.daysSinceLastPurchase / b.avgDaysBetweenPurchases : b.purchaseCount;
        return scoreB - scoreA;
      });

      return resp(200, {
        suggestions: suggestions.slice(0, 10),
        activePlanId: activePlan?.id ?? null,
      });
    }

    // ========================================================
    // GET /activity
    // ========================================================
    if (method === "GET" && path.endsWith("/activity")) {
      const familyId = qs.familyId || "demo-family";
      const limitStr = qs.limit as string | undefined;
      const limit    = limitStr ? parseInt(limitStr, 10) : 20;

      const r = await dynamo.send(new ScanCommand({
        TableName: ACTIVITY_TABLE,
        FilterExpression: "familyId = :fid",
        ExpressionAttributeValues: { ":fid": familyId },
      }));

      const activities = (r.Items || [])
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit);

      return resp(200, { activities });
    }

    return resp(404, { error: "Route not found" });

  } catch (error) {
    console.error("FamilyCart error:", error);
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      return resp(404, { error: "Record not found" });
    }
    return resp(500, {
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
};
