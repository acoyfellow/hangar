import { Option } from 'effect'
import { Command, click, expect, given, role, scene, text } from 'foldkit/scene'
import { test } from 'vitest'

import { Lane, type Launched } from './domain'
import { LaunchRace, Message, init, update, view } from './main'

const launched: Launched = {
  taskId: 't-1',
  runId: 'wfp-1',
  path: 'pooled',
  runVia: 'warmed',
  launchedAt: 1,
  dispatchMs: 3,
}

test('race button starts both lanes', () => {
  scene(
    { update, view },
    given(init().model),
    click(role('button', { name: 'Race: ready box vs fresh box' })),
    expect(role('button', { name: 'Launching…' })).toExist(),
    Command.resolve(LaunchRace, Message.SucceededLaunch({ pooled: launched, cold: { ...launched, taskId: 't-2', path: 'cold', runVia: 'cold' } })),
    expect(text('Run dispatched in 3 ms…')).toExist(),
  )
})

test('a dispatched lane shows its dispatch time', () => {
  const model = {
    ...init().model,
    maybePooled: Option.some(Lane.make({ launched, maybeView: Option.none(), approvalSent: false })),
  }
  scene({ update, view }, given(model), expect(text('Run dispatched in 3 ms…')).toExist())
})

