/** The five roles a card's timeline names; a row with none is the site's own (a move, the creation). */
export type Role = "planner" | "builder" | "reviewer" | "verifier" | "landing";
export const ROLES: readonly Role[] = ["planner", "builder", "reviewer", "verifier", "landing"];
export const ROLE_LABEL: Record<Role, string> = { planner: "Planner", builder: "Builder", reviewer: "Reviewer", verifier: "Verifier", landing: "Landing" };
