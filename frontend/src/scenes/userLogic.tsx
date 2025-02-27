import React from 'react'
import { kea } from 'kea'
import api from 'lib/api'
import { userLogicType } from './userLogicType'
import { UserType } from '~/types'
import posthog from 'posthog-js'
import { toast } from 'react-toastify'

interface UpdateUserPayload {
    user: Partial<UserType>
    successCallback?: () => void
}

export const userLogic = kea<userLogicType<UserType, UpdateUserPayload>>({
    actions: () => ({
        loadUser: (resetOnFailure?: boolean) => ({ resetOnFailure }),
        updateCurrentTeam: (teamId: number, destination?: string) => ({ teamId, destination }),
        updateCurrentOrganization: (organizationId: string, destination?: string) => ({ organizationId, destination }),
        logout: true,
    }),
    reducers: {
        user: [
            null as UserType | null,
            {
                setUser: (_, payload) => payload.user,
                userUpdateSuccess: (_, payload) => payload.user,
            },
        ],
        userUpdateLoading: [
            false,
            {
                userUpdateRequest: () => true,
                userUpdateSuccess: () => false,
                userUpdateFailure: () => false,
            },
        ],
    },
    selectors: ({ selectors }) => ({
        demoOnlyProject: [
            () => [selectors.user],
            (user): boolean =>
                (user?.team?.is_demo && user?.organization?.teams && user.organization.teams.length == 1) || false,
        ],
    }),
    loaders: ({ values, actions }) => ({
        user: [
            null as UserType | null,
            {
                loadUser: async () => {
                    try {
                        const user: UserType = await api.get('api/users/@me/')

                        if (user && user.uuid) {
                            const Sentry = (window as any).Sentry
                            Sentry?.setUser({
                                email: user.email,
                                id: user.uuid,
                            })

                            if (posthog) {
                                // If user is not anonymous and the distinct id is different from the current one, reset
                                if (
                                    posthog.get_property('$device_id') !== posthog.get_distinct_id() &&
                                    posthog.get_distinct_id() !== user.distinct_id
                                ) {
                                    posthog.reset()
                                }

                                posthog.identify(user.distinct_id)
                                posthog.people.set({ email: user.anonymize_data ? null : user.email })

                                posthog.register({
                                    is_demo_project: user.team?.is_demo,
                                })
                            }
                        }
                        return user
                    } catch (error) {
                        console.error(error)
                        actions.loadUserFailure(error.message)
                    }
                    return null
                },
                updateUser: async ({ user, successCallback }: UpdateUserPayload) => {
                    if (!values.user) {
                        throw new Error('Current user has not been loaded yet, so it cannot be updated!')
                    }
                    try {
                        const response = await api.update('api/users/@me/', user)
                        successCallback && successCallback()
                        return response
                    } catch (error) {
                        console.error(error)
                        actions.updateUserFailure(error.message)
                    }
                },
            },
        ],
    }),
    listeners: ({ values }) => ({
        logout: () => {
            posthog.reset()
            window.location.href = '/logout'
        },
        updateUserSuccess: () => {
            toast.dismiss('updateUser')
            toast.success(
                <div>
                    <h1>Your preferences have been saved!</h1>
                    <p>All set. Click here to dismiss.</p>
                </div>,
                {
                    toastId: 'updateUser',
                }
            )
        },
        updateCurrentTeam: async ({ teamId, destination }, breakpoint) => {
            if (values.user?.team?.id === teamId) {
                return
            }
            await breakpoint(10)
            await api.update('api/users/@me/', { set_current_team: teamId })
            window.location.href = destination || '/'
        },
        updateCurrentOrganization: async ({ organizationId, destination }, breakpoint) => {
            if (values.user?.organization?.id === organizationId) {
                return
            }
            await breakpoint(10)
            await api.update('api/users/@me/', { set_current_organization: organizationId })
            window.location.href = destination || '/'
        },
    }),
    events: ({ actions }) => ({
        afterMount: [actions.loadUser],
    }),
})
