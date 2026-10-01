import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea,
} from '@axiom/ui';

export const FieldGroup = () => (
  <Card style={{ width: 400 }}>
    <CardHeader>
      <CardTitle>New DSAR intake</CardTitle>
      <CardDescription>Record a data principal request for triage.</CardDescription>
    </CardHeader>
    <CardContent>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Label htmlFor="cc1" required>
            Requester name
          </Label>
          <Input id="cc1" defaultValue="Ananya Iyer" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Label htmlFor="cc2">Request details</Label>
          <Textarea id="cc2" placeholder="Describe the request" />
        </div>
      </div>
    </CardContent>
  </Card>
);

export const TextContent = () => (
  <Card style={{ width: 400 }}>
    <CardHeader>
      <CardTitle>Retention schedule</CardTitle>
      <CardDescription>Applies to the support ticket archive.</CardDescription>
    </CardHeader>
    <CardContent>
      <p style={{ margin: 0, fontSize: 14 }}>
        Tickets are retained for 12 months after closure, then queued for erasure review.
      </p>
    </CardContent>
  </Card>
);
