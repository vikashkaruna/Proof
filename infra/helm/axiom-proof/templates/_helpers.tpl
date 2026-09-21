{{/*
Expand the name of the chart.
*/}}
{{- define "axiom-proof.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "axiom-proof.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "axiom-proof.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "axiom-proof.selectorLabels" . }}
{{- with .Values.labels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "axiom-proof.selectorLabels" -}}
app.kubernetes.io/name: {{ include "axiom-proof.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Pod template labels.

Separate from selectorLabels because spec.selector.matchLabels is immutable on
an existing Deployment — widening it would make every upgrade fail. Pod labels
are free to grow, and they have to: the NetworkPolicies select on
app.kubernetes.io/part-of, which lives in .Values.labels and was emitted only
on object metadata. Both allow- policies therefore selected zero pods while
the default-deny selected all of them, leaving every workload with DNS and
nothing else.
*/}}
{{- define "axiom-proof.podLabels" -}}
{{ include "axiom-proof.selectorLabels" . }}
{{- with .Values.labels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "axiom-proof.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "axiom-proof.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
