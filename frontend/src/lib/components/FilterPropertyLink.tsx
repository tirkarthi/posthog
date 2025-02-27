import React from 'react'
import { combineUrl } from 'kea-router'

import { Property } from 'lib/components/Property'
import { Link } from 'lib/components/Link'
import { parseProperties } from 'lib/components/PropertyFilters/propertyFilterLogic'
import { FilterType } from '~/types'

export function FilterPropertyLink({
    property,
    value,
    filters,
    onClick,
    className,
}: {
    property: string
    value: string | number
    filters: FilterType
    onClick?: (property: string, value: string | number) => void
    className?: string
}): JSX.Element {
    const cleanedProperties = Array.isArray(filters.properties)
        ? filters.properties
        : parseProperties(filters.properties)

    // In case the property we're linking to is already in the filter, remove it, otherwise add it
    const properties = cleanedProperties.find((p: any) => p.key === property && p.value === value && !p.operator)
        ? cleanedProperties.filter((p: any) => p.key !== property || p.value !== value || p.operator)
        : [...cleanedProperties, { key: property, value: value }]

    const { url } = combineUrl(
        window.location.pathname,
        {
            ...filters,
            properties,
        },
        {}
    )

    return (
        <Link
            to={url}
            className={className}
            onClick={() => {
                if (onClick) {
                    onClick(property, value)
                }
            }}
        >
            <Property value={value} />
        </Link>
    )
}
