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

{{/* Only reviewed deployed modes; onprem is an explicit offline contract. */}}
{{- define "axiom-proof.environment" -}}
{{- $environment := .Values.config.environment -}}
{{- if not (has $environment (list "production" "onprem")) -}}
{{- fail "config.environment must be production or onprem" -}}
{{- end -}}
{{- $environment -}}
{{- end -}}

{{/* Default tag behavior is retained; offline images require immutable digests. */}}
{{- define "axiom-proof.image" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $digest := index ($root.Values.image.digests | default dict) $component | default "" -}}
{{- if eq (include "axiom-proof.environment" $root) "onprem" -}}
{{- if ne $root.Values.image.pullPolicy "Never" -}}
{{- fail "onprem image.pullPolicy must be Never" -}}
{{- end -}}
{{- $digest = required (printf "onprem image digest required for %s" $component) $digest -}}
{{- end -}}
{{- if $digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail (printf "invalid immutable image digest for %s" $component) -}}
{{- end -}}
{{- printf "%s/axiom-%s@%s" $root.Values.image.registry $component $digest -}}
{{- else -}}
{{- printf "%s/axiom-%s:%s" $root.Values.image.registry $component $root.Values.image.tag -}}
{{- end -}}
{{- end -}}

{{/* License token and public trust root only. Authority private keys stay external. */}}
{{- define "axiom-proof.offlineLicenseEnv" -}}
{{- if eq (include "axiom-proof.environment" .) "onprem" -}}
{{- $name := required "onprem config.offlineLicenseSecretName is required" .Values.config.offlineLicenseSecretName -}}
- name: AXIOM_OFFLINE_LICENSE
  valueFrom:
    secretKeyRef:
      name: {{ $name | quote }}
      key: license
- name: AXIOM_LICENSE_ROOT_PUBLIC_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $name | quote }}
      key: root-public-key
{{- end -}}
{{- end -}}

{{/* Supported BFF/runtime S3 adapter fields; credentials never reach frontends. */}}
{{- define "axiom-proof.onpremStorageEnv" -}}
{{- if eq (include "axiom-proof.environment" .) "onprem" -}}
{{- $name := required "onprem config.storageSecretName is required" .Values.config.storageSecretName -}}
{{- $endpoint := required "onprem config.storageEndpoint is required" .Values.config.storageEndpoint -}}
- name: AXIOM_EVIDENCE_BUCKET
  value: {{ .Values.config.s3EvidenceBucket | quote }}
- name: AXIOM_STORAGE_ENDPOINT
  value: {{ $endpoint | quote }}
- name: AXIOM_STORAGE_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ $name | quote }}
      key: access-key-id
- name: AXIOM_STORAGE_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $name | quote }}
      key: secret-access-key
{{- end -}}
{{- end -}}
