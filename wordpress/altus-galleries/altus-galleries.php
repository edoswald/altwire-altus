<?php
/**
 * Plugin Name:  Altus RAG — Gallery Endpoint
 * Description:  Exposes NextGEN gallery metadata via a REST endpoint for ingestion by the Altus MCP server. Endpoint: GET /wp-json/altus/v1/galleries
 * Version:      1.0.0
 * Author:       Cirrusly Weather
 * License:      Proprietary
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'rest_api_init', function () {
    register_rest_route( 'altus/v1', '/galleries', [
        'methods'             => 'GET',
        'callback'            => 'altus_get_galleries',
        'permission_callback' => function () {
            return current_user_can( 'edit_posts' );
        },
    ] );
} );

function altus_get_galleries( WP_REST_Request $request ) {
    global $wpdb;

    $page     = max( 1, intval( $request->get_param( 'page' ) ?? 1 ) );
    $per_page = min( 100, intval( $request->get_param( 'per_page' ) ?? 50 ) );
    $offset   = ( $page - 1 ) * $per_page;

    $galleries = $wpdb->get_results( $wpdb->prepare(
        "SELECT g.gid, g.title, g.galdesc, g.slug, g.pageid, g.previewpic,
                COUNT(i.pid) AS image_count
         FROM {$wpdb->prefix}ngg_gallery g
         LEFT JOIN {$wpdb->prefix}ngg_pictures i ON i.galleryid = g.gid AND i.exclude = 0
         GROUP BY g.gid
         ORDER BY g.gid ASC
         LIMIT %d OFFSET %d",
        $per_page,
        $offset
    ) );

    if ( empty( $galleries ) ) {
        return rest_ensure_response( [] );
    }

    $result = [];
    foreach ( $galleries as $gallery ) {
        $images = $wpdb->get_results( $wpdb->prepare(
            "SELECT alttext, description
             FROM {$wpdb->prefix}ngg_pictures
             WHERE galleryid = %d AND exclude = 0
             ORDER BY sortorder ASC
             LIMIT 50",
            $gallery->gid
        ) );

        $page_url = '';
        if ( $gallery->pageid ) {
            $page_url = get_permalink( $gallery->pageid ) ?: '';
        }

        $result[] = [
            'id'          => $gallery->gid,
            'title'       => $gallery->title,
            'description' => $gallery->galdesc,
            'slug'        => $gallery->slug,
            'url'         => $page_url,
            'image_count' => (int) $gallery->image_count,
            'images'      => array_map( fn( $img ) => [
                'alt'     => $img->alttext,
                'caption' => $img->description,
            ], $images ),
        ];
    }

    return rest_ensure_response( $result );
}
