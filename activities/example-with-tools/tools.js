// Custom tools for this activity (Phase 5 escape hatch).
//
// Each tool is { name, description, input_schema, handler(input, ctx) }.
// ctx = { db, user, activity } — db is already scoped to this activity's event,
// so counts here only ever see this workshop's signups. The handler's return
// value (stringified) is handed back to the model as the tool result.

const CAPACITY = 20;

export const tools = [
  {
    name: "check_seat_availability",
    description:
      "查询工作坊的实时剩余名额。当用户问到还有没有位子、剩多少名额时调用。",
    input_schema: { type: "object", properties: {}, required: [] },
    handler(_input, { db }) {
      // Count people who've locked in a seat (completed the signup).
      const taken = db
        .getUserSummaries()
        .filter((u) => u.status === "completed").length;
      const left = Math.max(0, CAPACITY - taken);
      return left > 0
        ? `还剩 ${left} 个名额（共 ${CAPACITY} 个）`
        : `名额已满（共 ${CAPACITY} 个），只能候补了`;
    },
  },
];
