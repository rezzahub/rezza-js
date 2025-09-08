import { WorkflowBuilder, parse, t } from "@rezza.io/workflow";

const schema = t.Object({
  firstNumber: t.Number({ description: "First number" }),
  secondNumber: t.Number({ description: "Second number" }),
});

export default WorkflowBuilder.create()
  .addNode({ key: "input", schema }, (ctx) => {
    const res = ctx.step({
      key: "numbers",
      description: "Enter new pair",
      schema,
    });
    return parse(schema, res);
  })
  .addNode(
    { key: "sum", deps: ["input"], schema: t.Number() },
    ({ get }) => get("input").firstNumber + get("input").secondNumber,
  )
  .build();
