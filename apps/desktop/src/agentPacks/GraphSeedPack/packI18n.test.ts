import { describe, expect, it } from 'vitest'
import { graphSeedPackManifest as manifest } from './index'

const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ru'] as const

function contentNodes(graph: { nodes: Record<string, unknown>[] }): string[] {
  return graph.nodes
    .filter((node) => {
      const config = node.config as { content?: unknown } | undefined
      return typeof config?.content === 'string' && config.content.trim().length > 0
    })
    .map((node) => node.id as string)
}

describe('GraphSeedPack i18n', () => {
  it('covers every agent, pipeline, mode and node in all five locales', () => {
    for (const agent of manifest.resources.agents) {
      for (const locale of LOCALES) {
        const overlay = agent.i18n?.[locale]
        expect(overlay?.display_name?.trim(), `${agent.resource_key}/${locale} display_name`).toBeTruthy()
        expect(overlay?.description?.trim(), `${agent.resource_key}/${locale} description`).toBeTruthy()
        expect(overlay?.system_prompt?.trim(), `${agent.resource_key}/${locale} system_prompt`).toBeTruthy()
      }
    }

    for (const pipeline of manifest.resources.prompt_pipelines) {
      const nodeIds = contentNodes(pipeline.graph)
      for (const locale of LOCALES) {
        const overlay = pipeline.i18n?.[locale]
        expect(overlay?.display_name?.trim(), `${pipeline.resource_key}/${locale} display_name`).toBeTruthy()
        expect(overlay?.description?.trim(), `${pipeline.resource_key}/${locale} description`).toBeTruthy()
        expect(Object.keys(overlay?.templates ?? {}).sort(), `${pipeline.resource_key}/${locale} templates`).toEqual([...nodeIds].sort())
        for (const nodeId of nodeIds) {
          expect(overlay!.templates![nodeId].trim(), `${pipeline.resource_key}/${locale}/${nodeId}`).toBeTruthy()
        }
      }
    }

    for (const mode of manifest.resources.modes) {
      for (const locale of LOCALES) {
        const overlay = mode.i18n?.[locale]
        expect(overlay?.display_name?.trim(), `${mode.resource_key}/${locale} display_name`).toBeTruthy()
        expect(overlay?.description?.trim(), `${mode.resource_key}/${locale} description`).toBeTruthy()
        expect(overlay!.description!.length, `${mode.resource_key}/${locale} description length`).toBeLessThanOrEqual(50)
        for (const node of mode.nodes) {
          const label = node.i18n?.[locale]?.label
          expect(label?.trim(), `${mode.resource_key}/${locale}/${node.node_key} label`).toBeTruthy()
        }
      }
    }
  })

  it('keeps translated prompts structurally aligned with the Chinese baseline', () => {
    for (const agent of manifest.resources.agents) {
      const baseLines = agent.system_prompt?.split('\n').length ?? 0
      for (const locale of LOCALES.filter((item) => item !== 'zh-CN')) {
        expect(agent.i18n![locale].system_prompt!.split('\n').length, `${agent.resource_key}/${locale} newlines`).toBe(baseLines)
      }
    }
    for (const pipeline of manifest.resources.prompt_pipelines) {
      for (const nodeId of contentNodes(pipeline.graph)) {
        const base = pipeline.graph.nodes.find((node) => node.id === nodeId)!.config as { content: string }
        const baseLines = base.content.split('\n').length
        for (const locale of LOCALES.filter((item) => item !== 'zh-CN')) {
          expect(pipeline.i18n![locale].templates![nodeId].split('\n').length,
            `${pipeline.resource_key}/${locale}/${nodeId} newlines`).toBe(baseLines)
        }
      }
    }
  })
})
