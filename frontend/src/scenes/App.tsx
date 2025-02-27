import React, { useEffect } from 'react'
import { kea, useActions, useValues } from 'kea'
import { Layout } from 'antd'
import { ToastContainer, Slide } from 'react-toastify'

import { MainNavigation, TopNavigation, DemoWarnings } from '~/layout/navigation'
import { BillingAlerts } from 'lib/components/BillingAlerts'
import { userLogic } from 'scenes/userLogic'
import { sceneLogic, Scene } from 'scenes/sceneLogic'
import { SceneLoading } from 'lib/utils'
import { router } from 'kea-router'
import { CommandPalette } from 'lib/components/CommandPalette'
import { UpgradeModal } from './UpgradeModal'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { preflightLogic } from './PreflightCheck/logic'
import { BackTo } from 'lib/components/BackTo'
import { Papercups } from 'lib/components/Papercups'
import { appLogicType } from './AppType'
import { PreflightStatus } from '~/types'

export const appLogic = kea<appLogicType<PreflightStatus>>({
    actions: {
        enableDelayedSpinner: true,
        ignoreFeatureFlags: true,
    },
    reducers: {
        showingDelayedSpinner: [false, { enableDelayedSpinner: () => true }],
        featureFlagsTimedOut: [false, { ignoreFeatureFlags: () => true }],
    },
    selectors: {
        showApp: [
            (s) => [
                userLogic.selectors.userLoading, // not loading the user anymore (may be logged out)
                userLogic.selectors.user, // if we have the user, skip loading check
                featureFlagLogic.selectors.receivedFeatureFlags, // received feature flags
                s.featureFlagsTimedOut, // waited for 3 sec to load feature flags, that's enough
                preflightLogic.selectors.preflightLoading,
                preflightLogic.selectors.preflight,
            ],
            (userLoading, user, receivedFeatureFlags, featureFlagsTimedOut, preflightLoading, preflight) => {
                return (
                    (!userLoading || user) &&
                    (receivedFeatureFlags || featureFlagsTimedOut) &&
                    (!preflightLoading || preflight)
                )
            },
        ],
    },
    events: ({ actions, cache }) => ({
        afterMount: () => {
            cache.spinnerTimeout = window.setTimeout(() => actions.enableDelayedSpinner(), 1000)
            cache.featureFlagTimeout = window.setTimeout(() => actions.ignoreFeatureFlags(), 3000)
        },
        beforeUnmount: () => {
            window.clearTimeout(cache.spinnerTimeout)
            window.clearTimeout(cache.featureFlagTimeout)
        },
    }),
})

export function App(): JSX.Element | null {
    const { showApp, showingDelayedSpinner } = useValues(appLogic)
    return showApp ? <AppScene /> : showingDelayedSpinner ? <SceneLoading /> : null
}

function AppScene(): JSX.Element | null {
    const { user } = useValues(userLogic)
    const { scene, params, loadedScenes, sceneConfig } = useValues(sceneLogic)
    const { preflight } = useValues(preflightLogic)
    const { location } = useValues(router)
    const { replace } = useActions(router)
    const { featureFlags } = useValues(featureFlagLogic)
    const { showingDelayedSpinner } = useValues(appLogic)

    useEffect(() => {
        if (scene === Scene.Signup && preflight && !preflight.cloud && preflight.initiated) {
            // If user is on an initiated self-hosted instance, redirect away from signup
            replace('/login')
            return
        }
    }, [scene, preflight])

    useEffect(() => {
        if (user) {
            // If user is already logged in, redirect away from unauthenticated-only routes like signup
            if (sceneConfig.onlyUnauthenticated) {
                replace('/')
                return
            }

            // Redirect to org/project creation if there's no org/project respectively, unless using invite
            if (scene !== Scene.InviteSignup) {
                if (!user.organization) {
                    if (location.pathname !== '/organization/create') {
                        replace('/organization/create')
                    }
                    return
                } else if (!user.team) {
                    if (location.pathname !== '/project/create') {
                        replace('/project/create')
                    }
                    return
                }

                // If ingestion tutorial not completed, redirect to it
                if (
                    !user.team?.completed_snippet_onboarding &&
                    !location.pathname.startsWith('/ingestion') &&
                    !location.pathname.startsWith('/personalization')
                ) {
                    replace('/ingestion')
                    return
                }
            }
        }
    }, [scene, user])

    const SceneComponent: (...args: any[]) => JSX.Element | null =
        (scene ? loadedScenes[scene]?.component : null) || (() => (showingDelayedSpinner ? <SceneLoading /> : null))

    const essentialElements = (
        // Components that should always be mounted inside Layout
        <>
            {featureFlags['papercups-enabled'] && <Papercups />}
            <ToastContainer autoClose={8000} transition={Slide} position="top-right" />
        </>
    )

    if (!user) {
        return sceneConfig.onlyUnauthenticated || sceneConfig.allowUnauthenticated ? (
            <Layout style={{ minHeight: '100vh' }}>
                <SceneComponent {...params} />
                {essentialElements}
            </Layout>
        ) : null
    }

    if (sceneConfig.plain) {
        return (
            <Layout style={{ minHeight: '100vh' }}>
                {!sceneConfig.hideTopNav && <TopNavigation />}
                <SceneComponent user={user} {...params} />
                {essentialElements}
            </Layout>
        )
    }

    return (
        <>
            <Layout>
                <MainNavigation />
                <Layout className={`${sceneConfig.dark ? 'bg-mid' : ''}`} style={{ minHeight: '100vh' }}>
                    {!sceneConfig.hideTopNav && <TopNavigation />}
                    {scene ? (
                        <Layout.Content className="main-app-content" data-attr="layout-content">
                            {!sceneConfig.hideDemoWarnings && <DemoWarnings />}
                            <BillingAlerts />
                            <BackTo />
                            <SceneComponent user={user} {...params} />
                        </Layout.Content>
                    ) : null}
                </Layout>
                {essentialElements}
            </Layout>
            <UpgradeModal />
            <CommandPalette />
        </>
    )
}
