import { Input, Label, Textarea } from '@axiom/ui';

const field = { display: 'flex', flexDirection: 'column' as const, gap: 6, width: 340 };

export const Required = () => (
  <div style={field}>
    <Label htmlFor="l1" required>
      Requester full name
    </Label>
    <Input id="l1" defaultValue="Ananya Iyer" />
  </div>
);

export const Optional = () => (
  <div style={field}>
    <Label htmlFor="l2">Alternate contact number</Label>
    <Input id="l2" placeholder="+91 98xxxxxx00" />
  </div>
);

export const WithTextarea = () => (
  <div style={field}>
    <Label htmlFor="l3" required>
      Approval reason
    </Label>
    <Textarea
      id="l3"
      defaultValue="Dry-run reviewed; rollback validated against the retention schedule."
    />
  </div>
);
