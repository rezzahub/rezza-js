# @rezza.io/workflow

## Getting Started

### Install

With NPM

```bash
npm add @rezza.io/workflow
```

With bun

```bash
bun add @rezza.io/workflow
```

### Create a workflow

```ts
import { WorkflowBuilder } from "@rezza.io/workflow";

const workflow = WorkflowBuilder.create()
  .addNode({ key: "name" }, () => "World")
  .addNode({ key: "greeting", deps: ["name"] }, ({ get }) => `Hello, ${get("name")}!`)
  .build();

const result = await workflow.run();
console.log(result.greeting); // Output: "Hello, World!"
```
