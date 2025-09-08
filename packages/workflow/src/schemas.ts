import type { TLiteral, TNull, TNumber } from "@sinclair/typebox";
import { type Static, Type } from "@sinclair/typebox";

/**
 * Schema representing a constant "done" value.
 * Used to mark a task as completed.
 *
 * @deprecated Use DoneWithNoteSchema and done() function instead for v0.8 compatibility
 */
export const DoneSchema: TLiteral<"done"> = Type.Const("done" as const, {
  title: "Mark the task as done",
});

/**
 * Type for enhanced completion result with optional note.
 */
export type DoneWithNote = Static<typeof DoneWithNoteSchema>;

/**
 * Constant value representing a completed task.
 * This is a typed alternative to the string literal "done".
 *
 * @deprecated Use done() function instead for v0.8 compatibility
 */
export const DONE: Static<typeof DoneSchema> = "done";

/**
 * Schema representing a null value.
 * Used to indicate a waiting or idle state.
 */
export const WaitSchema: TNull = Type.Null({ title: "zZz" });

/**
 * Schema representing the current timestamp.
 * Returns the number of milliseconds elapsed since the Unix epoch.
 */
export const NowSchema: TNumber = Type.Number({
  description: "Number of milliseconds elapsed since the epoch",
});

/**
 * Schema representing a random number.
 * Generates a pseudo-random number between 0 (inclusive) and 1 (exclusive).
 */
export const RandomSchema: TNumber = Type.Number({
  title: "Random Number",
  description: `Pseudo-random number that's greater than or equal to 0 and less than 1.`,
});

/**
 * Schema for enhanced completion result with optional note.
 * Used for Task and Validation nodes that return detailed completion information.
 */
export const DoneWithNoteSchema = Type.Object(
  {
    done: Type.Literal(true, { description: "Indicates task completion" }),
    note: Type.Optional(
      Type.String({ description: "Optional completion note" }),
    ),
  },
  {
    title: "Enhanced completion result",
    description: "Detailed completion information for tasks and validations",
  },
);

/**
 * Helper function to create a done result with optional note.
 * Used by Task nodes as default completion value.
 */
export const done = (note?: string): DoneWithNote => {
  return {
    done: true as const,
    note,
  };
};
