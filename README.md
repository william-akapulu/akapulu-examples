<p align="left">
  <img src="./logo.png" alt="Akapulu logo" width="220" />
</p>

## Examples

Akapulu helps you build conversational avatar experiences with real-time voice and video.

## Structure

```text
examples/
  fundamentals/
    simple-assistant/
    custom-rtvi-ui/
```

## Fundamentals

- `simple-assistant`
  - A super quick starter example for getting an Akapulu conversation running fast.
  - Uses the direct Daily URL handoff approach after connect.
  - Use it to understand the minimum setup, connect flow, and key request/response shape before moving to a custom RTVI UI.

- `custom-rtvi-ui`
  - A full custom frontend experience with RTVI events and tailored UI behavior.
  - This is the recommended approach for most real integrations.
  - Best when you want complete control over transcript, tool-call, and stage displays.
