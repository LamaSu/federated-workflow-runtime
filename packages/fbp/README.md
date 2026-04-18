# @delightfulchorus/fbp

Bidirectional bridge between [Chorus](https://github.com/LamaSu/federated-workflow-runtime) `Workflow` JSON and the [Flow-Based Programming](https://github.com/flowbased/fbp) (`.fbp`) text format.

Lets Chorus workflows interop with the FBP ecosystem (Noflo, Drawflow, fbp-graph) without
forking the runtime.

## Install

```bash
npm install @delightfulchorus/fbp
```

## Usage

```ts
import { fbpToChorus, chorusToFbp, parseFbp, emitFbp } from "@delightfulchorus/fbp";

// FBP text -> AST -> Chorus Workflow
const ast = parseFbp("A(MyComp) OUT -> IN B(Other)");
const workflow = fbpToChorus(ast, {
  id: "wf-1",
  name: "imported",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// Chorus Workflow -> AST -> FBP text
const ast2 = chorusToFbp(workflow);
const text = emitFbp(ast2);
```

## Mapping

| FBP concept              | Chorus concept                              |
|--------------------------|---------------------------------------------|
| `NAME(Component)`        | `Node { id: NAME, integration: Component }` |
| `A OUT -> IN B`          | `Connection { from: "A.OUT", to: "B.IN" }`  |
| `'data' -> IN B`         | `Node.inputs[IN] = 'data'` on node B         |
| `# @runtime foo`         | `metadata.runtime = "foo"` (preserved)      |

Ports are encoded into Chorus connection endpoints as `"nodeId.PORT"` so round-trip
(`fbp → chorus → fbp`) preserves them.

## Status

- parser: fbp text → AST via the `fbp` npm package
- adapter: AST ↔ Chorus `Workflow`
- emitter: AST → fbp text
- round-trip: `parseFbp → fbpToChorus → chorusToFbp → emitFbp` preserves structure
