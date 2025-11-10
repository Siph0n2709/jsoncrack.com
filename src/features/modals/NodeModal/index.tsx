import React from "react";
import type { ModalProps } from "@mantine/core";
import { Modal, Stack, Text, ScrollArea, Flex, CloseButton, Button, TextInput, Group } from "@mantine/core";
import { CodeHighlight } from "@mantine/code-highlight";
import type { NodeData } from "../../../types/graph";
import useGraph from "../../editor/views/GraphView/stores/useGraph";
import useJson from "../../../store/useJson";

// return object from json removing array and object fields
const normalizeNodeData = (nodeRows: NodeData["text"]) => {
  if (!nodeRows || nodeRows.length === 0) return "{}";
  if (nodeRows.length === 1 && !nodeRows[0].key) return `${nodeRows[0].value}`;

  const obj = {};
  nodeRows?.forEach(row => {
    if (row.type !== "array" && row.type !== "object") {
      if (row.key) obj[row.key] = row.value;
    }
  });
  return JSON.stringify(obj, null, 2);
};

// return json path in the format $["customer"]
const jsonPathToString = (path?: NodeData["path"]) => {
  if (!path || path.length === 0) return "$";
  const segments = path.map(seg => (typeof seg === "number" ? seg : `"${seg}"`));
  return `$[${segments.join("][")}]`;
};

export const NodeModal = ({ opened, onClose }: ModalProps) => {
  const nodeData = useGraph(state => state.selectedNode);

  // --- Editing State Model ---
  // isEditing: whether the modal is currently in edit mode for a primitive leaf node.
  // draftValue: local text representation of the node's value while editing (stringified for input).
  const [isEditing, setIsEditing] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState("");

  // A primitive leaf node in current graph representation has a single row with null key
  // and type not equal to object/array. Only those are editable.
  const isPrimitiveLeaf = React.useMemo(() => {
    if (!nodeData) return false;
    if (nodeData.text.length !== 1) return false; // multi-row indicates object with properties summary
    const row = nodeData.text[0];
    if (row.key !== null) return false; // objects with keys are aggregated differently
    return row.type !== "object" && row.type !== "array";
  }, [nodeData]);

  // An object node with primitive properties that can be edited in-place
  const isObjectEditable = React.useMemo(() => {
    if (!nodeData) return false;
    if (nodeData.text.length <= 1) return false;
    // editable if it has at least one primitive property
    return nodeData.text.some(
      r => r.key !== null && r.type !== "object" && r.type !== "array"
    );
  }, [nodeData]);

  // Draft map for object properties
  const [draftRows, setDraftRows] = React.useState<Record<string, string>>({});

  // Initialize draftValue when entering edit mode or node changes.
  React.useEffect(() => {
    if (!nodeData) {
      setIsEditing(false);
      setDraftValue("");
      setDraftRows({});
      return;
    }
    if (isEditing) {
      if (isPrimitiveLeaf) {
        setDraftValue(String(nodeData.text[0].value));
      } else if (isObjectEditable) {
        const map: Record<string, string> = {};
        nodeData.text.forEach(row => {
          if (row.key && row.type !== "object" && row.type !== "array") {
            map[row.key] = String(row.value);
          }
        });
        setDraftRows(map);
      }
    }
  }, [nodeData, isEditing, isPrimitiveLeaf, isObjectEditable]);

  const handleStartEdit = () => {
    if (!nodeData) return;
    if (isPrimitiveLeaf) {
      setDraftValue(String(nodeData.text[0].value));
    } else if (isObjectEditable) {
      const map: Record<string, string> = {};
      nodeData.text.forEach(row => {
        if (row.key && row.type !== "object" && row.type !== "array") {
          map[row.key] = String(row.value);
        }
      });
      setDraftRows(map);
    } else {
      return;
    }
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setDraftValue("");
    setDraftRows({});
    setError(null);
  };

  // --- Draft Parsing & Mutation Helpers ---
  const [error, setError] = React.useState<string | null>(null);

  const castDraftValue = () => {
    if (!nodeData) return undefined;
    const row = nodeData.text[0];
    const originalType = row.type;
    const raw = draftValue.trim();

    if (originalType === "null") return null;
    if (originalType === "number") {
      const num = Number(raw);
      if (Number.isNaN(num)) throw new Error("Value must be a number");
      return num;
    }
    if (originalType === "boolean") {
      if (raw.toLowerCase() === "true") return true;
      if (raw.toLowerCase() === "false") return false;
      throw new Error("Value must be true or false");
    }
    // Treat everything else as string; no quotes needed in input.
    return raw;
  };

  const updateJsonAtPath = (path: (string | number)[] | undefined, newValue: any) => {
    const currentJson = useJson.getState().getJson();
    let root: any;
    try {
      root = JSON.parse(currentJson);
    } catch (e) {
      throw new Error("Current JSON is invalid; cannot edit.");
    }

    if (!path || path.length === 0) {
      // Replace whole document with primitive
      return JSON.stringify(newValue, null, 2);
    }

    // Traverse to parent
    let parent: any = root;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      parent = parent[seg as any];
      if (typeof parent === "undefined") throw new Error("Path not found in JSON");
    }
    const last = path[path.length - 1];
    parent[last as any] = newValue;
    return JSON.stringify(root, null, 2);
  };

  const handleSaveEdit = () => {
    setError(null);
    if (!nodeData) return;
    try {
      let updatedJsonString: string | undefined;
      if (isPrimitiveLeaf) {
        const newTypedValue = castDraftValue();
        updatedJsonString = updateJsonAtPath(nodeData.path as any, newTypedValue);
      } else if (isObjectEditable) {
        // Update multiple primitive properties inside the object at path
        const currentJson = useJson.getState().getJson();
        const root = JSON.parse(currentJson);
        let target: any = root;
        (nodeData.path || []).forEach(seg => {
          target = target[seg as any];
        });
        if (typeof target !== "object" || target === null) throw new Error("Target is not an object");

        Object.entries(draftRows).forEach(([key, raw]) => {
          const originalRow = nodeData.text.find(r => r.key === key);
          if (!originalRow) return;
          const type = originalRow.type;
          let cast: any = (raw ?? "").trim();
          if (type === "number") {
            const num = Number(cast);
            if (Number.isNaN(num)) throw new Error(`Property ${key} must be a number`);
            cast = num;
          } else if (type === "boolean") {
            if (cast.toLowerCase() === "true") cast = true;
            else if (cast.toLowerCase() === "false") cast = false;
            else throw new Error(`Property ${key} must be true or false`);
          } else if (type === "null") {
            cast = null;
          } // strings stay as typed
          target[key] = cast;
        });

        updatedJsonString = JSON.stringify(root, null, 2);
      }
      if (!updatedJsonString) return;
      // Persist via store (this triggers graph regeneration)
      useJson.getState().setJson(updatedJsonString);
      // Re-focus same node after graph rebuild
      setTimeout(() => {
        const { nodes, setSelectedNode } = useGraph.getState();
        const match = nodes.find(n => JSON.stringify(n.path) === JSON.stringify(nodeData.path));
        if (match) setSelectedNode(match);
      }, 50);
      setIsEditing(false);
      setDraftRows({});
    } catch (e: any) {
      setError(e.message || "Failed to save changes");
    }
  };

  return (
    <Modal size="auto" opened={opened} onClose={onClose} centered withCloseButton={false}>
      <Stack pb="sm" gap="sm">
        <Stack gap="xs">
          <Flex justify="space-between" align="center">
            <Text fz="xs" fw={500}>
              Content
            </Text>
            <Flex align="center" gap="xs">
              {(isPrimitiveLeaf || isObjectEditable) && !isEditing && (
                <Button size="xs" variant="light" onClick={handleStartEdit}>
                  Edit
                </Button>
              )}
              <CloseButton onClick={onClose} />
            </Flex>
          </Flex>
          <ScrollArea.Autosize mah={250} maw={600}>
            {isEditing && isPrimitiveLeaf ? (
              <Stack gap="xs" miw={350} maw={600}>
                <TextInput
                  size="xs"
                  label="Value"
                  value={draftValue}
                  onChange={e => setDraftValue(e.currentTarget.value)}
                  error={error || undefined}
                  description={"Enter a " + (nodeData?.text[0].type || "value")}
                  autoFocus
                />
                <Group gap="xs">
                  <Button size="xs" variant="filled" color="green" onClick={handleSaveEdit}>
                    Save
                  </Button>
                  <Button size="xs" variant="light" color="gray" onClick={handleCancelEdit}>
                    Cancel
                  </Button>
                </Group>
              </Stack>
            ) : isEditing && isObjectEditable ? (
              <Stack gap="xs" miw={350} maw={600}>
                {nodeData?.text.map(row => {
                  if (!row.key) return null;
                  const isNested = row.type === "object" || row.type === "array";
                  if (isNested) {
                    const label = row.key;
                    const placeholder = row.type === "object" ? `{${row.childrenCount ?? 0} keys}` : `[${row.childrenCount ?? 0} items]`;
                    return (
                      <TextInput key={label} size="xs" label={label} value={placeholder} disabled />
                    );
                  }
                  return (
                    <TextInput
                      key={row.key}
                      size="xs"
                      label={row.key}
                      value={draftRows[row.key] ?? ""}
                      onChange={e =>
                        setDraftRows(dr => ({ ...dr, [row.key as string]: e.currentTarget.value }))
                      }
                      error={error && error.toLowerCase().includes((row.key || "").toLowerCase()) ? error : undefined}
                    />
                  );
                })}
                <Group gap="xs">
                  <Button size="xs" variant="filled" color="green" onClick={handleSaveEdit}>
                    Save
                  </Button>
                  <Button size="xs" variant="light" color="gray" onClick={handleCancelEdit}>
                    Cancel
                  </Button>
                </Group>
                {error && (
                  <Text fz="11px" c="red.6">{error}</Text>
                )}
              </Stack>
            ) : (
              <CodeHighlight
                code={normalizeNodeData(nodeData?.text ?? [])}
                miw={350}
                maw={600}
                language="json"
                withCopyButton
              />
            )}
          </ScrollArea.Autosize>
        </Stack>
        <Text fz="xs" fw={500}>
          JSON Path
        </Text>
        <ScrollArea.Autosize maw={600}>
          <CodeHighlight
            code={jsonPathToString(nodeData?.path)}
            miw={350}
            mah={250}
            language="json"
            copyLabel="Copy to clipboard"
            copiedLabel="Copied to clipboard"
            withCopyButton
          />
        </ScrollArea.Autosize>
        {/* Debug info (development only) */}
        {process.env.NODE_ENV === "development" && (
          <Text fz="10px" c="dimmed">
            PrimitiveEditable: {String(isPrimitiveLeaf)} | ObjectEditable: {String(isObjectEditable)} | isEditing: {String(isEditing)}
          </Text>
        )}
      </Stack>
    </Modal>
  );
};
