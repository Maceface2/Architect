import type { NodeTypes } from '@xyflow/react'
import ZoneNode from './ZoneNode'
import ComponentNode from './ComponentNode'

export const nodeTypes: NodeTypes = {
  zone: ZoneNode,
  component: ComponentNode,
}
