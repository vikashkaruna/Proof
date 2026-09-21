# Render fixtures

Each `*-values.yaml` here is one configuration the CI render gate renders the
chart under, in addition to the chart defaults. They exist because rendering
the defaults alone is not sufficient coverage: a `{{- with }}` block guarding
an empty map never executes, so a template can carry a defect that only appears
once an operator sets the value in a real environment. The ServiceAccount
annotation bug fixed alongside this directory was exactly that shape — it
rendered clean on defaults and produced invalid YAML the moment an IRSA role
was attached.

A fixture is not an environment and holds no secrets. It exists to force a
branch of the templates to execute. Add one whenever a template grows a
conditional that the defaults leave cold.
