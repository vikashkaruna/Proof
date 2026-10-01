import { Badge, Button, PageHeader } from '@axiom/ui';

export const WithModuleBar = () => (
  <div style={{ width: 760 }}>
    <PageHeader
      title="Approval queue"
      description="Recorded actions awaiting human review. Open the source plan to inspect the dry-run, rollback, scope, and approval authority before taking action."
      module={{
        crumb: 'Remediate',
        titleHi: 'अनुमोदन कंसोल',
        phase: 'P3',
        moduleId: 'M3.3',
        agents: ['sudhaar', 'karya'],
      }}
    />
  </div>
);

export const WithActionsAndMeta = () => (
  <div style={{ width: 760 }}>
    <PageHeader
      title="Evidence vault"
      description="Content-addressed, write-once evidence with source, timestamp and hash for every artifact."
      actions={
        <>
          <Button variant="outline" size="sm">
            Export pack
          </Button>
          <Button variant="primary" size="sm">
            Record evidence
          </Button>
        </>
      }
      meta={
        <>
          <Badge variant="neutral">Region: ap-south-1</Badge>
          <Badge variant="proof">Object Lock: Compliance</Badge>
        </>
      }
    />
  </div>
);

export const TitleOnly = () => (
  <div style={{ width: 760 }}>
    <PageHeader title="Remediation plans" />
  </div>
);
