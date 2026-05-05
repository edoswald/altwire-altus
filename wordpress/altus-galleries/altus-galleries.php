<?php
/**
 * Plugin Name:  Altus RAG — Gallery + Editorial Endpoints
 * Description:  Exposes NextGEN gallery metadata and Altus editorial workflow endpoints for the Altus MCP server.
 * Version:      1.1.0
 * Author:       Cirrusly Weather
 * License:      Proprietary
 *
 * Endpoints:
 *   GET  /wp-json/altus/v1/galleries         — NextGEN gallery metadata (existing)
 *   POST /wp-json/altus/v1/posts            — Create post with Altus metadata
 *   GET  /wp-json/altus/v1/posts            — Lookup posts (by assignment_id, status, author)
 *   PATCH /wp-json/altus/v1/posts/:id       — Update post (status, publish)
 *   GET  /wp-json/altus/v1/authors          — List authors for byline attribution
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'rest_api_init', function () {

    // -------------------------------------------------------------------------
    // GET /altus/v1/galleries (existing)
    // -------------------------------------------------------------------------
    register_rest_route( 'altus/v1', '/galleries', [
        'methods'  => 'GET',
        'callback' => 'altus_get_galleries',
        'permission_callback' => function () {
            return current_user_can( 'edit_posts' );
        },
    ] );

    // -------------------------------------------------------------------------
    // POST /altus/v1/posts — create post with Altus metadata
    // Body: { title, content, status, assignment_id, article_type, source_query, author_id, categories, tags }
    // -------------------------------------------------------------------------
    register_rest_route( 'altus/v1', '/posts', [
        'methods'  => 'POST',
        'callback' => 'altus_create_post',
        'permission_callback' => function () {
            return current_user_can( 'edit_posts' );
        },
    ] );

    // -------------------------------------------------------------------------
    // GET /altus/v1/posts — lookup posts by assignment_id, status, or author
    // Query: assignment_id, status, author, per_page, page
    // -------------------------------------------------------------------------
    register_rest_route( 'altus/v1', '/posts', [
        'methods'  => 'GET',
        'callback' => 'altus_list_posts',
        'permission_callback' => function () {
            return current_user_can( 'edit_posts' );
        },
    ] );

    // -------------------------------------------------------------------------
    // PATCH /altus/v1/posts/:id — update post status or publish
    // Body: { status, publish, author_id, categories, tags }
    // -------------------------------------------------------------------------
    register_rest_route( 'altus/v1', '/posts/(?P<id>\d+)', [
        'methods'  => 'PATCH',
        'callback' => 'altus_update_post',
        'permission_callback' => function () {
            return current_user_can( 'edit_posts' );
        },
    ] );

    // -------------------------------------------------------------------------
    // GET /altus/v1/authors — list users with author role for byline
    // -------------------------------------------------------------------------
    register_rest_route( 'altus/v1', '/authors', [
        'methods'  => 'GET',
        'callback' => 'altus_list_authors',
        'permission_callback' => function () {
            return current_user_can( 'edit_posts' );
        },
    ] );

} );

// -------------------------------------------------------------------------
// Gallery endpoint (unchanged from v1.0.0)
// -------------------------------------------------------------------------
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

// -------------------------------------------------------------------------
// POST /altus/v1/posts — create post with Altus metadata
// -------------------------------------------------------------------------
function altus_create_post( WP_REST_Request $request ) {
    $params = $request->get_json_params();

    $title        = $params['title']        ?? '';
    $content      = $params['content']      ?? '';
    $status       = $params['status']       ?? 'draft';
    $assignment_id = isset( $params['assignment_id'] ) ? (int) $params['assignment_id'] : null;
    $article_type = $params['article_type'] ?? 'article';
    $source_query = $params['source_query'] ?? '';
    $author_id    = isset( $params['author_id'] ) ? (int) $params['author_id'] : null;
    $categories   = $params['categories']     ?? [];
    $tags         = $params['tags']           ?? [];

    if ( empty( $title ) ) {
        return new WP_Error( 'missing_title', 'title is required', [ 'status' => 400 ] );
    }

    $post_data = [
        'post_title'   => $title,
        'post_content' => $content,
        'post_status'   => $status,
        'post_author'  => $author_id ?: get_current_user_id(),
    ];

    $post_id = wp_insert_post( $post_data, true );

    if ( is_wp_error( $post_id ) ) {
        return $post_id;
    }

    // Store Altus metadata as post meta
    if ( $assignment_id ) {
        update_post_meta( $post_id, 'altus_assignment_id', $assignment_id );
    }
    update_post_meta( $post_id, 'altus_article_type', sanitize_text_field( $article_type ) );
    if ( $source_query ) {
        update_post_meta( $post_id, 'altus_source_query', sanitize_text_field( $source_query ) );
    }

    // Set categories
    if ( ! empty( $categories ) ) {
        wp_set_object_terms( $post_id, $categories, 'category', false );
    }

    // Set tags
    if ( ! empty( $tags ) ) {
        wp_set_object_terms( $post_id, $tags, 'post_tag', false );
    }

    return rest_ensure_response( [
        'id'            => $post_id,
        'url'           => get_permalink( $post_id ),
        'edit_url'      => get_edit_post_link( $post_id, 'edit' ),
        'status'        => get_post_status( $post_id ),
        'assignment_id' => $assignment_id,
        'article_type'  => $article_type,
    ] );
}

// -------------------------------------------------------------------------
// GET /altus/v1/posts — lookup posts
// -------------------------------------------------------------------------
function altus_list_posts( WP_REST_Request $request ) {
    global $wpdb;

    $assignment_id = $request->get_param( 'assignment_id' );
    $status        = $request->get_param( 'status' );
    $author        = $request->get_param( 'author' );
    $per_page      = min( 100, intval( $request->get_param( 'per_page' ) ?? 20 ) );
    $page          = max( 1, intval( $request->get_param( 'page' ) ?? 1 ) );
    $offset        = ( $page - 1 ) * $per_page;

    $where = [ "1=1" ];
    $params = [];

    if ( $assignment_id !== null ) {
        $assignment_id = (int) $assignment_id;
        $where[]  = "pm_meta.meta_value = %d AND pm_meta.meta_key = 'altus_assignment_id'";
        $params[] = $assignment_id;
    }

    if ( $status ) {
        $where[]  = "p.post_status = %s";
        $params[] = $status;
    }

    if ( $author ) {
        $where[]  = "p.post_author = %d";
        $params[] = (int) $author;
    }

    $where_sql = implode( ' AND ', $where );

    if ( $assignment_id !== null ) {
        // JOIN-based query when filtering by assignment_id meta
        $sql = $wpdb->prepare(
            "SELECT p.ID, p.post_title, p.post_status, p.post_date, p.post_author,
                    pm_meta.meta_value AS assignment_id,
                    pm_type.meta_value AS article_type
             FROM {$wpdb->posts} p
             JOIN {$wpdb->postmeta} pm_meta ON pm_meta.post_id = p.ID
             LEFT JOIN {$wpdb->postmeta} pm_type ON pm_type.post_id = p.ID AND pm_type.meta_key = 'altus_article_type'
             WHERE {$where_sql}
             ORDER BY p.post_date DESC
             LIMIT %d OFFSET %d",
            array_merge( $params, [ $per_page, $offset ] )
        );
    } else {
        $sql = $wpdb->prepare(
            "SELECT p.ID, p.post_title, p.post_status, p.post_date, p.post_author
             FROM {$wpdb->posts} p
             WHERE {$where_sql}
             ORDER BY p.post_date DESC
             LIMIT %d OFFSET %d",
            array_merge( $params, [ $per_page, $offset ] )
        );
    }

    $posts = $wpdb->get_results( $sql );

    $result = array_map( function ( $post ) {
        return [
            'id'           => (int) $post->ID,
            'title'        => $post->post_title,
            'status'       => $post->post_status,
            'date'         => $post->post_date,
            'url'          => get_permalink( $post->ID ),
            'edit_url'     => get_edit_post_link( $post->ID, 'edit' ),
            'author_id'    => (int) $post->post_author,
            'assignment_id' => isset( $post->assignment_id ) ? (int) $post->assignment_id : null,
            'article_type'  => isset( $post->article_type ) ? $post->article_type : null,
        ];
    }, $posts );

    return rest_ensure_response( $result );
}

// -------------------------------------------------------------------------
// PATCH /altus/v1/posts/:id — update post
// -------------------------------------------------------------------------
function altus_update_post( WP_REST_Request $request ) {
    $post_id = (int) $request->get_param( 'id' );
    $post    = get_post( $post_id );

    if ( ! $post ) {
        return new WP_Error( 'not_found', 'Post not found', [ 'status' => 404 ] );
    }

    $params = $request->get_json_params();

    $update = [];

    if ( isset( $params['status'] ) ) {
        $update['post_status'] = sanitize_text_field( $params['status'] );
    }

    if ( isset( $params['title'] ) ) {
        $update['post_title'] = sanitize_text_field( $params['title'] );
    }

    if ( isset( $params['content'] ) ) {
        $update['post_content'] = wp_kses_post( $params['content'] );
    }

    if ( isset( $params['author_id'] ) ) {
        $update['post_author'] = (int) $params['author_id'];
    }

    if ( ! empty( $update ) ) {
        $update['ID'] = $post_id;
        $result = wp_update_post( $update, true );
        if ( is_wp_error( $result ) ) {
            return $result;
        }
    }

    // Publish immediately if requested
    if ( ! empty( $params['publish'] ) && $params['publish'] ) {
        wp_update_post( [ 'ID' => $post_id, 'post_status' => 'publish' ] );
    }

    // Update categories
    if ( isset( $params['categories'] ) ) {
        wp_set_object_terms( $post_id, $params['categories'], 'category', false );
    }

    // Update tags
    if ( isset( $params['tags'] ) ) {
        wp_set_object_terms( $post_id, $params['tags'], 'post_tag', false );
    }

    // Update altus metadata
    if ( isset( $params['article_type'] ) ) {
        update_post_meta( $post_id, 'altus_article_type', sanitize_text_field( $params['article_type'] ) );
    }

    if ( isset( $params['source_query'] ) ) {
        update_post_meta( $post_id, 'altus_source_query', sanitize_text_field( $params['source_query'] ) );
    }

    $updated = get_post( $post_id );

    return rest_ensure_response( [
        'id'           => $post_id,
        'url'          => get_permalink( $post_id ),
        'edit_url'     => get_edit_post_link( $post_id, 'edit' ),
        'status'       => $updated->post_status,
        'article_type' => get_post_meta( $post_id, 'altus_article_type', true ),
    ] );
}

// -------------------------------------------------------------------------
// GET /altus/v1/authors — list users with edit_posts capability
// -------------------------------------------------------------------------
function altus_list_authors( WP_REST_Request $request ) {
    $per_page = min( 100, intval( $request->get_param( 'per_page' ) ?? 20 ) );
    $page     = max( 1, intval( $request->get_param( 'page' ) ?? 1 ) );
    $offset   = ( $page - 1 ) * $per_page;

    $users = get_users( [
        'who'    => 'authors',
        'offset' => $offset,
        'number' => $per_page,
    ] );

    $result = array_map( function ( $user ) {
        return [
            'id'         => $user->ID,
            'name'       => $user->display_name,
            'login'      => $user->user_login,
            'email'      => $user->user_email,
            'avatar_url' => get_avatar_url( $user->ID ),
        ];
    }, $users );

    return rest_ensure_response( $result );
}