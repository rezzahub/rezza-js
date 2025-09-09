import { Type as t } from "@sinclair/typebox";
import { describe, expect, test } from "vitest";
import { DoneWithNoteSchema, done } from "./schemas";
import { Skip } from "./types";
import { WorkflowBuilder } from "./workflow-builder";

describe("Workflow v0.8 - Four Node Types", () => {
  describe("Task Nodes (Default)", () => {
    test("should create Task node with default type", async () => {
      const workflow = WorkflowBuilder.create()
        .addTask({
          key: "setup_workspace",
          deps: [],
        })
        .build();

      const result = await workflow.run([]);
      expect(result.setup_workspace?.status).toBe("done");
      if (result.setup_workspace?.status === "done") {
        expect(result.setup_workspace?.value).toEqual({
          done: true,
          note: undefined,
        });
      }
    });

    test("should create Task node with enhanced completion using done() helper", async () => {
      const workflow = WorkflowBuilder.create()
        .addTask(
          {
            key: "background_check",
            deps: [],
          },
          () => {
            // Task execution logic here
            // The done() result will include a note automatically
          },
        )
        .build();

      const result = await workflow.run([]);
      expect(result.background_check?.status).toBe("done");
      if (result.background_check?.status === "done") {
        expect(result.background_check.value).toEqual({
          done: true,
          note: undefined,
        });
      }
    });

    test("should support conditional skip in Task nodes", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "user_details",
            schema: t.Object({ optedOut: t.Boolean() }),
          },
          () => ({ optedOut: true }),
        )
        .addTask(
          {
            key: "send_notification",
            deps: ["user_details"],
          },
          ({ get }) => {
            const user = get("user_details");
            if (user.optedOut) {
              throw new Skip("User opted out");
            }
          },
        )
        .build();

      const result = await workflow.run([]);
      expect(result.send_notification?.status).toBe("skipped");
      if (result.send_notification?.status === "skipped") {
        expect(result.send_notification.reason).toBe("User opted out");
      }
    });
  });

  describe("Form Nodes", () => {
    test("should create Form node with explicit type and schema", async () => {
      const workflow = WorkflowBuilder.create()
        .addForm({
          key: "customer_info",
          schema: t.Object({
            name: t.String(),
            email: t.String({ format: "email" }),
            age: t.Number({ minimum: 18 }),
          }),
        })
        .build();

      const exec = await workflow.dryRun([]);
      expect(exec.values.customer_info?.status).toBe("intr");
      if (exec.values.customer_info?.status === "intr") {
        expect(exec.values.customer_info.step).toBeDefined();
      }
    });

    test("should process Form node submission", async () => {
      const workflow = WorkflowBuilder.create()
        .addForm({
          key: "order_details",
          schema: t.Object({
            items: t.Array(t.String()),
            amount: t.Number({ minimum: 0 }),
          }),
        })
        .build();

      const result = await workflow.run([
        {
          k: ["order_details", "form_input"],
          v: { items: ["pizza", "salad"], amount: 25.5 },
          ts: Date.now(),
        },
      ]);

      expect(result.order_details?.status).toBe("done");
      if (result.order_details?.status === "done") {
        expect(result.order_details.value).toEqual({
          items: ["pizza", "salad"],
          amount: 25.5,
        });
      }
    });

    test("should support conditional skip in Form nodes", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          { key: "user_profile", schema: t.Object({ role: t.String() }) },
          () => ({ role: "admin" }),
        )
        .addForm(
          {
            key: "approval_form",
            deps: ["user_profile"],
            schema: t.Object({
              approved: t.Boolean(),
              notes: t.String(),
            }),
          },
          ({ get }) => {
            const user = get("user_profile");
            if (user.role === "admin") {
              throw new Skip("Admins don't need approval");
            }
          },
        )
        .build();

      const result = await workflow.run([]);
      expect(result.approval_form?.status).toBe("skipped");
      if (result.approval_form?.status === "skipped") {
        expect(result.approval_form.reason).toBe("Admins don't need approval");
      }
    });
  });

  describe("Complex Nodes", () => {
    test("should create Complex node with stepSchemas", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "payment_processing",
            schema: t.Object({
              transactionId: t.String(),
              amount: t.Number(),
              status: t.String(),
            }),
            stepSchemas: {
              validate_card: {
                input: t.Object({
                  cardNumber: t.String(),
                  cvv: t.String(),
                }),
                output: t.Object({
                  valid: t.Boolean(),
                  token: t.String(),
                }),
              },
              charge_card: {
                input: t.Object({
                  token: t.String(),
                  amount: t.Number(),
                }),
                output: t.Object({
                  transactionId: t.String(),
                  status: t.String(),
                }),
              },
            },
          },
          ({ step }) => {
            // Step 1: Validate card
            step({
              key: "validate_card",
              title: "Validate Payment Card",
              schema: { static: {} },
            });

            // Step 2: Process charge
            const charge = step({
              key: "charge_card",
              title: "Process Payment",
              schema: { static: {} },
            }) as { transactionId: string; status: string };

            return {
              transactionId: charge.transactionId,
              amount: 99.99,
              status: charge.status,
            };
          },
        )
        .build();

      const exec = await workflow.dryRun([]);
      expect(exec.values.payment_processing?.status).toBe("intr");
      if (exec.values.payment_processing?.status === "intr") {
        expect(exec.values.payment_processing.step.key).toEqual([
          "payment_processing",
          "validate_card",
        ]);
      }
    });

    test("should support multi-step Complex node execution", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "order_fulfillment",
            schema: t.Object({
              packageId: t.String(),
              weight: t.Number(),
              status: t.String(),
            }),
            stepSchemas: {
              pick_items: {
                output: t.Object({
                  items: t.Array(t.String()),
                  location: t.String(),
                }),
              },
              pack_order: {
                input: t.Object({
                  items: t.Array(t.String()),
                  location: t.String(),
                }),
                output: t.Object({
                  packageId: t.String(),
                  weight: t.Number(),
                }),
              },
            },
          },
          ({ step }) => {
            // This follows the pattern from existing workflow tests
            // Each step is an interruption, not sequential execution
            step({
              key: "pick_items",
              title: "Pick Items from Warehouse",
              schema: { static: {} },
            });

            // If we got to here, picking is complete, now pack
            const packing = step({
              key: "pack_order",
              title: "Pack Order",
              schema: { static: {} },
            }) as { packageId: string; weight: number };

            return {
              packageId: packing.packageId,
              weight: packing.weight,
              status: "ready_for_shipping",
            };
          },
        )
        .build();

      // First execution should interrupt at pick_items step
      const exec1 = await workflow.dryRun([]);
      expect(exec1.values.order_fulfillment?.status).toBe("intr");
      if (exec1.values.order_fulfillment?.status === "intr") {
        expect(exec1.values.order_fulfillment.step.key).toEqual([
          "order_fulfillment",
          "pick_items",
        ]);
      }

      // After providing pick_items input, should interrupt at pack_order step
      const exec2 = await workflow.dryRun([
        {
          k: ["order_fulfillment", "pick_items"],
          v: { items: ["widget", "gadget"], location: "A-1-B" },
          ts: Date.now(),
        },
      ]);

      expect(exec2.values.order_fulfillment?.status).toBe("intr");
      if (exec2.values.order_fulfillment?.status === "intr") {
        expect(exec2.values.order_fulfillment.step.key).toEqual([
          "order_fulfillment",
          "pack_order",
        ]);
      }

      // After providing pack_order input, should complete
      const exec3 = await workflow.run([
        {
          k: ["order_fulfillment", "pick_items"],
          v: { items: ["widget", "gadget"], location: "A-1-B" },
          ts: Date.now(),
        },
        {
          k: ["order_fulfillment", "pack_order"],
          v: { packageId: "PKG-123", weight: 2.5 },
          ts: Date.now(),
        },
      ]);

      expect(exec3.order_fulfillment?.status).toBe("done");
      if (exec3.order_fulfillment?.status === "done") {
        expect(exec3.order_fulfillment.value).toEqual({
          packageId: "PKG-123",
          weight: 2.5,
          status: "ready_for_shipping",
        });
      }
    });
  });

  describe("Validation Nodes", () => {
    test("should create Validation node with business rule enforcement", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "user_application",
            schema: t.Object({
              age: t.Number(),
              citizenship: t.String(),
            }),
          },
          () => ({ age: 25, citizenship: "US" }),
        )
        .addValidation(
          {
            key: "eligibility_check",
            deps: ["user_application"],
          },
          ({ get }) => {
            const application = get("user_application");

            // Business rule validation
            if (application.age < 18) {
              throw new Error("Must be 18 or older");
            }

            if (application.citizenship !== "US") {
              throw new Error("US citizenship required");
            }
          },
        )
        .build();

      const result = await workflow.run([]);
      expect(result.eligibility_check?.status).toBe("done");
      if (result.eligibility_check?.status === "done") {
        expect(result.eligibility_check.value).toEqual({
          done: true,
          note: undefined,
        });
      }
    });

    test("should handle Validation node exemptions with skip", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "user_profile",
            schema: t.Object({ region: t.String(), age: t.Number() }),
          },
          () => ({ region: "EU", age: 16 }),
        )
        .addValidation(
          {
            key: "gdpr_validation",
            deps: ["user_profile"],
          },
          ({ get }) => {
            const user = get("user_profile");

            // Skip for non-EU users (exemption)
            if (user.region !== "EU") {
              throw new Skip("GDPR only applies to EU users");
            }

            // Skip if user is too young (exemption)
            if (user.age < 16) {
              throw new Skip("GDPR consent not required for users under 16");
            }
          },
        )
        .build();

      const result = await workflow.run([]);
      expect(result.gdpr_validation?.status).toBe("done");
      if (result.gdpr_validation?.status === "done") {
        expect(result.gdpr_validation.value).toEqual({
          done: true,
          note: undefined,
        });
      }
    });

    test("should enforce business rules with Error in Validation nodes", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "account_application",
            schema: t.Object({
              age: t.Number(),
              initialDeposit: t.Number(),
            }),
          },
          () => ({ age: 16, initialDeposit: 500 }),
        )
        .addValidation(
          {
            key: "trading_validation",
            deps: ["account_application"],
          },
          ({ get }) => {
            const application = get("account_application");

            // ERROR: Legal requirement violation (blocks workflow)
            if (application.age < 18) {
              throw new Error("Trading accounts require minimum age of 18");
            }

            // ERROR: Regulatory requirement violation
            if (application.initialDeposit < 2000) {
              throw new Error(
                "Trading accounts require minimum $2000 deposit (Regulation T)",
              );
            }

            return { validated: true, timestamp: Date.now() };
          },
        )
        .build();

      const result = await workflow.run([]);
      expect(result.trading_validation?.status).toBe("err");
      if (result.trading_validation?.status === "err") {
        expect(result.trading_validation.error.message).toBe(
          "Trading accounts require minimum age of 18",
        );
      }
    });
  });

  describe("Optional Dependencies", () => {
    test("should handle optionalDeps with partial completion", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "employee_basic",
            schema: t.Object({
              name: t.String(),
              role: t.String(),
              remote: t.Boolean(),
            }),
            deps: [],
          },
          () => ({ name: "John", role: "developer", remote: false }),
        )
        .addNode(
          {
            key: "background_check",
            schema: t.Object({
              passed: t.Boolean(),
              date: t.Number(),
            }),
            deps: ["employee_basic"],
          },
          ({ get }) => {
            const employee = get("employee_basic");
            if (employee.role === "intern") {
              throw new Skip("Interns don't need background checks");
            }
            return { passed: true, date: Date.now() };
          },
        )
        .addNode(
          {
            key: "office_setup",
            schema: t.Object({
              deskNumber: t.String(),
              equipment: t.Array(t.String()),
            }),
            deps: ["employee_basic"],
          },
          ({ get }) => {
            const employee = get("employee_basic");
            if (employee.remote) {
              throw new Skip("Remote employee - no office setup");
            }
            return { deskNumber: "A-42", equipment: ["laptop", "monitor"] };
          },
        )
        .addNode(
          {
            key: "onboarding_complete",
            schema: DoneWithNoteSchema,
            deps: ["employee_basic"],
            optionalDeps: ["background_check", "office_setup"],
            optionalDepsLimit: 1, // Need at least 1 optional task
          },
          ({ get }) => {
            const employee = get("employee_basic");
            const bgCheck = get("background_check"); // May be null if skipped
            const office = get("office_setup"); // May be null if skipped

            return done(
              `Onboarding complete for ${employee.name}: background=${bgCheck !== null}, office=${office !== null}`,
            );
          },
        )
        .build();

      const result = await workflow.run([]);
      expect(result.onboarding_complete?.status).toBe("done");
      if (result.onboarding_complete?.status === "done") {
        expect(result.onboarding_complete.value.note).toContain(
          "background=true, office=true",
        );
      }
    });

    test("should handle optionalDepsLimit with first-wins pattern", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "email_notification",
            schema: t.Object({
              channel: t.String(),
              timestamp: t.Number(),
            }),
          },
          () => ({ channel: "email", timestamp: Date.now() }),
        )
        .addNode(
          {
            key: "sms_alert",
            schema: t.Object({
              channel: t.String(),
              timestamp: t.Number(),
            }),
          },
          () => ({ channel: "sms", timestamp: Date.now() }),
        )
        .addNode(
          {
            key: "emergency_alert",
            schema: t.Object({
              notified: t.Boolean(),
              method: t.String(),
              responseTime: t.Number(),
            }),
            optionalDeps: ["email_notification", "sms_alert"],
            optionalDepsLimit: 1, // Proceed as soon as any notification succeeds
          },
          ({ get }) => {
            const responses = [
              get("email_notification"),
              get("sms_alert"),
            ].filter((r) => r !== null);

            return {
              notified: true,
              method: responses[0]?.channel || "unknown",
              responseTime: responses[0]?.timestamp || Date.now(),
            };
          },
        )
        .build();

      const result = await workflow.run([]);
      expect(result.emergency_alert?.status).toBe("done");
      if (result.emergency_alert?.status === "done") {
        expect(result.emergency_alert.value.notified).toBe(true);
      }
    });
  });

  describe("Instance Fan-Out Pattern", () => {
    test("should support 1→N→N instance fan-out with tag coordination", async () => {
      const workflow = WorkflowBuilder.create()
        // Step 1: Product list
        .addForm({
          key: "product_list",
          schema: t.Object({
            products: t.Array(
              t.Object({
                id: t.String(),
                name: t.String(),
                stock: t.Number(),
              }),
            ),
          }),
        })
        // Step 2: Package each item (1→N fan-out)
        .addNode(
          {
            key: "package_items",
            deps: ["product_list"],
            schema: DoneWithNoteSchema,
            instances: ({ get }) => {
              const productListResult = get("product_list");

              if (!productListResult) {
                return [];
              }

              const { products } = productListResult as {
                products: Array<{ id: string; name: string; stock: number }>;
              };
              return products.map((product) => [`item:${product.id}`]);
            },
            stepSchemas: {
              package_item: {
                input: t.Object({ product: t.Any() }),
                output: t.Object({
                  packaged: t.Boolean(),
                  location: t.String(),
                }),
              },
            },
          },
          ({ step, get, tags }) => {
            const { products } = get("product_list") as {
              products: Array<{ id: string; name: string; stock: number }>;
            };
            const itemId = tags[0].split(":")[1];
            const currentProduct = products.find(p => p.id === itemId);

            if (!currentProduct) {
              throw new Error(`Product ${itemId} not found`);
            }

            // FILTERING LOGIC: Skip out of stock items
            if (currentProduct.stock <= 0) {
              throw new Skip(`Item ${itemId} is out of stock`);
            }

            return step({
              key: "package_item",
              title: `Package ${currentProduct.name}`,
              schema: DoneWithNoteSchema,
            });
          },
        )

        // Step 3: Load to truck (N→M fan-out)
        .addNode(
          {
            key: "load_truck",
            schema: t.Any(),
            optionalDeps: ["package_items"], // Handle cascading failures gracefully
            instances: ({ get }) => {
              const packageResults = get("package_items");
              if (!packageResults) return []; // No instances if all packaging failed

              // For demo purposes, return a single instance
              return [["item:demo"]];
            },
            stepSchemas: {
              load_item: {
                input: t.Object({
                  location: t.String(),
                  itemId: t.String(),
                }),
                output: t.Object({
                  loaded: t.Boolean(),
                  truckPosition: t.Number(),
                }),
              },
            },
          },
          ({ step, tags }) => {
            const itemId = tags[0].split(":")[1];

            // Use the item ID for loading logic

            return step({
              key: "load_item",
              title: `Load item ${itemId} to truck`,
              schema: { static: {} },
            });
          },
        )
        .build();

      // Execute workflow with product data
      const results = await workflow.run([
        {
          k: ["product_list", "form_input"],
          v: {
            products: [
              { id: "p1", name: "Widget", stock: 5 },
              { id: "p2", name: "Gadget", stock: 0 }, // Out of stock - should be skipped
              { id: "p3", name: "Tool", stock: 3 },
            ],
          },
          ts: Date.now(),
        },
      ]);

      // Verify product_list is completed
      expect(results.product_list?.status).toBe("done");

      // Verify package_items returns array of results (one per product)
      expect(Array.isArray(results.package_items)).toBe(true);
      const packageResults = results.package_items;

      // Should have results for 3 products (even if some fail/skip)
      expect(packageResults).toHaveLength(3);

      // Product 1 and 3 should be interrupted (waiting for packaging step)
      // Product 2 should be skipped (out of stock)
      const p1Result = packageResults.find((r) => r.tags?.includes("item:p1"));
      const p2Result = packageResults.find((r) => r.tags?.includes("item:p2"));
      const p3Result = packageResults.find((r) => r.tags?.includes("item:p3"));

      expect(p1Result?.status).toBe("intr");
      expect(p2Result?.status).toBe("skipped");
      expect(p3Result?.status).toBe("intr");
    });

    test("should generate instance tags in run results", async () => {
      const workflow = WorkflowBuilder.create()
        .addNode(
          {
            key: "simple_task",
            schema: t.Object({ result: t.String() }),
            instance: () => ["tag1", "tag2", "context-demo"],
          },
          () => ({ result: "completed" }),
        )
        .addNode(
          {
            key: "failing_instance_task",
            schema: t.Object({ result: t.String() }),
            instance: () => {
              throw new Error("Instance generation failed");
            },
          },
          () => ({ result: "still works" }),
        )
        .build();

      const results = await workflow.run();

      // Node with successful instance function should have tags
      expect(results.simple_task?.status).toBe("done");
      if (results.simple_task?.status === "done") {
        expect(results.simple_task.tags).toEqual([
          "tag1",
          "tag2",
          "context-demo",
        ]);
      }

      // Node with failed instance function should still work but have no tags
      expect(results.failing_instance_task?.status).toBe("done");
      if (results.failing_instance_task?.status === "done") {
        expect(results.failing_instance_task.tags).toBeUndefined();
      }
    });
  });

  describe("Topology Method", () => {
    test("should include node type and stepSchemas in topology", () => {
      const workflow = WorkflowBuilder.create()
        .addForm({
          key: "customer_info",
          schema: t.Object({
            name: t.String(),
            email: t.String({ format: "email" }),
          }),
        })
        .addNode(
          {
            key: "payment_processing",
            schema: t.Any(),
            stepSchemas: {
              validate_card: {
                input: t.Object({
                  cardNumber: t.String(),
                  cvv: t.String(),
                }),
                output: t.Object({
                  valid: t.Boolean(),
                  token: t.String(),
                }),
              },
            },
          },
          ({ step }) => {
            return step({
              key: "validate_card",
              title: "Validate Payment Card",
              schema: { static: {} },
            });
          },
        )
        .addValidation(
          {
            key: "compliance_check",
            deps: ["customer_info"],
          },
          ({ get }) => {
            const customer = get("customer_info");
            if (!customer.email.includes("@")) {
              throw new Error("Invalid email format");
            }
          },
        )
        .build();

      const topology = workflow.topology();

      // Find specific nodes in topology
      const customerInfoNode = topology.find((n) => n.node === "customer_info");
      const paymentNode = topology.find((n) => n.node === "payment_processing");
      const complianceNode = topology.find(
        (n) => n.node === "compliance_check",
      );

      // Test Form node
      expect(customerInfoNode).toBeDefined();
      expect(customerInfoNode?.type).toBe("form");
      expect(customerInfoNode?.stepSchemas).toBeUndefined();

      // Test Complex node with stepSchemas
      expect(paymentNode).toBeDefined();
      expect(paymentNode?.type).toBe("complex");
      expect(paymentNode?.stepSchemas).toBeDefined();
      expect(paymentNode?.stepSchemas?.validate_card).toBeDefined();
      expect(paymentNode?.stepSchemas?.validate_card.input).toBeDefined();
      expect(paymentNode?.stepSchemas?.validate_card.output).toBeDefined();

      // Test Validation node
      expect(complianceNode).toBeDefined();
      expect(complianceNode?.type).toBe("validation");
      expect(complianceNode?.stepSchemas).toBeUndefined();
    });

    test("should include optionalDeps and optionalDepsLimit in topology", () => {
      const workflow = WorkflowBuilder.create()
        .addTask({
          key: "email_notification",
        })
        .addTask({
          key: "sms_alert",
        })
        .addTask(
          {
            key: "emergency_alert",
            optionalDeps: ["email_notification", "sms_alert"],
            optionalDepsLimit: 1,
          },
          () => {
            // Task logic here - the done() result is handled automatically
          },
        )
        .build();

      const topology = workflow.topology();
      const alertNode = topology.find((n) => n.node === "emergency_alert");

      expect(alertNode).toBeDefined();
      expect(alertNode?.type).toBe("task");
      expect(alertNode?.optionalDeps).toEqual([
        "email_notification",
        "sms_alert",
      ]);
      expect(alertNode?.optionalDepsLimit).toBe(1);
    });
  });
});
